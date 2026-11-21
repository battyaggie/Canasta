// The 3D card table: three.js, on a normal screen (mouse or touch) or in a headset (WebXR, VR or passthrough).
// It holds no game state of its own. web/app.ts owns the connection and the game, calls update() with a
// snapshot whenever something changes, and gets the player's taps back through TableActions, so every move
// goes through the same checks as on a phone.
import * as THREE from 'three';
import { ALL_CARDS, isCanasta, isNaturalCanasta, isWild, sideOf, type MeldPlay, type PlayerView } from '../../engine/src/index.js';
import { CARD_H, CARD_W, cardBack, cardFace, disposeObject, textPanel } from './text.js';

export interface TableModel {
  view: PlayerView;
  seatNames: string[];
  seatOnline: boolean[];
  /** Hand already sorted the way the 2D app shows it, without staged cards. */
  hand: number[];
  selected: ReadonlySet<number>;
  staged: readonly MeldPlay[];
  target: MeldPlay['rank'] | null;
  canAddToMelds: boolean;
  canSkipDiscard: boolean;
  canLookThrough: boolean;
  scoreLine: string;
  hint: string;
  toast: string | null;
  connection: string | null;
  /** Pass & play: whose turn it is while the cards are hidden. */
  coveredFor: string | null;
  overlay: { title: string; lines: string[]; button: 'nextHand' | 'rematch' | null } | null;
}

export interface TableActions {
  tapCard(id: number): void;
  tapMeld(rank: MeldPlay['rank']): void;
  tapStock(): void;
  tapPile(): void;
  tapCloth(): void;
  layDown(): void;
  clear(): void;
  skipDiscard(): void;
  reveal(): void;
  nextHand(): void;
  rematch(): void;
  closeOverlay(): void;
  exit(): void;
}

type Hit =
  | { kind: 'card'; id: number }
  | { kind: 'meld'; rank: MeldPlay['rank'] }
  | { kind: 'stock' }
  | { kind: 'pile' }
  | { kind: 'cloth' }
  | { kind: 'button'; run: () => void };

// ------------------------------------------------------------------ layout (metres)
// The player sits at the origin looking down -z. The table top is at TABLE_Y, eyes at about EYE_Y.
const TABLE_Y = 0.72;
const EYE_Y = 1.22;
const TABLE_Z = -0.55;
const TABLE_W = 1.4;
const TABLE_D = 1.0;
const LIFT = 0.0006; // keeps stacked flat cards from flickering into each other

const SEAT_COLORS = [0x3d7bd9, 0xd96a3d, 0x47a86b, 0xa04fc9];

interface AvatarParts {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Mesh;
  left: THREE.Mesh;
  right: THREE.Mesh;
  reach: { to: THREE.Vector3; start: number } | null;
}

export async function xrSupport(): Promise<{ vr: boolean; ar: boolean }> {
  const xr = (navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr;
  if (!xr) return { vr: false, ar: false };
  const [vr, ar] = await Promise.all([xr.isSessionSupported('immersive-vr').catch(() => false), xr.isSessionSupported('immersive-ar').catch(() => false)]);
  return { vr, ar };
}

export class Table3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 1, 0.02, 30);
  /** Everything at the table moves together when the player recentres in a headset. */
  private tableRoot = new THREE.Group();
  /** Rebuilt on every update(). */
  private dynamic = new THREE.Group();
  private room = new THREE.Group();
  private avatars = new Map<number, AvatarParts>();
  private hits: THREE.Object3D[] = [];
  private named = new Map<string, THREE.Object3D>();
  private hovered = new Set<THREE.Object3D>();
  private raycaster = new THREE.Raycaster();
  private model: TableModel | null = null;
  private previous: TableModel | null = null;
  private resizeObserver: ResizeObserver;
  private controllers: { ray: THREE.Group; line: THREE.Line; source: XRInputSource | null }[] = [];
  private hands: { hand: THREE.Group; armed: boolean }[] = [];
  private session: XRSession | null = null;
  private needsRecentre = false;
  private framesInSession = 0;
  private lastToast: string | null = null;
  private pointerDown: { x: number; y: number } | null = null;
  private clock = new THREE.Clock();

  constructor(
    private host: HTMLElement,
    private actions: TableActions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '3D card table');

    this.scene.background = new THREE.Color(0x14231c);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334433, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(0.5, 2.5, 1);
    this.scene.add(sun);

    // On a flat screen the view is from a little higher and further back than a seated head,
    // so the whole table fits; in a headset the player's real head takes over.
    this.camera.position.set(0, 1.4, 0.34);
    this.camera.lookAt(0, TABLE_Y + 0.08, TABLE_Z - 0.1);
    this.scene.add(this.camera);

    this.buildRoom();
    this.tableRoot.add(this.buildTable());
    this.tableRoot.add(this.dynamic);
    this.scene.add(this.tableRoot);
    this.setupControllers();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);

    // Browser tests click on things in the scene by name.
    (window as unknown as { __canasta3d?: unknown }).__canasta3d = {
      point: (name: string) => this.screenPoint(name),
      names: () => [...this.named.keys()],
      world: (name: string) => this.named.get(name)?.getWorldPosition(new THREE.Vector3()).toArray() ?? null,
      presenting: () => this.renderer.xr.isPresenting,
    };
  }

  // ---------------------------------------------------------------- public

  update(model: TableModel): void {
    this.previous = this.model;
    this.model = model;
    this.rebuild();
    this.animateAvatarsFromChanges();
    if (model.toast && model.toast !== this.lastToast) this.buzz();
    this.lastToast = model.toast;
  }

  async enterXR(mode: 'immersive-vr' | 'immersive-ar'): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr || this.session) return;
    const session = await xr.requestSession(mode, { optionalFeatures: ['local-floor', 'hand-tracking'] });
    this.session = session;
    const passthrough = mode === 'immersive-ar';
    this.scene.background = passthrough ? null : new THREE.Color(0x14231c);
    this.room.visible = !passthrough;
    session.addEventListener('end', () => {
      this.session = null;
      this.scene.background = new THREE.Color(0x14231c);
      this.room.visible = true;
      this.tableRoot.position.set(0, 0, 0);
      this.tableRoot.rotation.set(0, 0, 0);
      this.rebuild();
    });
    await this.renderer.xr.setSession(session);
    this.needsRecentre = true;
    this.framesInSession = 0;
    this.rebuild();
  }

  dispose(): void {
    void this.session?.end().catch(() => undefined);
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    delete (window as unknown as { __canasta3d?: unknown }).__canasta3d;
  }

  /** Where a named object appears on screen, in CSS pixels (for tests). */
  screenPoint(name: string): { x: number; y: number } | null {
    const obj = this.named.get(name);
    if (!obj) return null;
    // Cards in a fan overlap: aim at the corner index, the part that is always visible.
    const isCard = (obj.userData.hit as Hit | undefined)?.kind === 'card';
    const p = isCard ? obj.localToWorld(new THREE.Vector3(-CARD_W * 0.35, CARD_H * 0.3, 0)) : obj.getWorldPosition(new THREE.Vector3());
    p.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  // ---------------------------------------------------------------- fixed scenery

  private buildRoom(): void {
    const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshStandardMaterial({ color: 0x3b2f27, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2;
    this.room.add(floor);
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 6, 4, 48, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x24382e, side: THREE.BackSide, roughness: 1 }),
    );
    wall.position.y = 2;
    this.room.add(wall);
    const lamp = new THREE.PointLight(0xffe2b0, 3, 4, 1.5);
    lamp.position.set(0, 2.1, TABLE_Z);
    this.room.add(lamp);
    this.scene.add(this.room);
  }

  private buildTable(): THREE.Group {
    const g = new THREE.Group();
    const felt = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W, 0.03, TABLE_D), new THREE.MeshStandardMaterial({ color: 0x0f5c3a, roughness: 0.9 }));
    felt.position.set(0, TABLE_Y - 0.015, TABLE_Z);
    felt.userData.hit = { kind: 'cloth' } satisfies Hit;
    felt.userData.ownsGeometry = true;
    this.hits.push(felt);
    this.named.set('cloth', felt);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W + 0.08, 0.05, TABLE_D + 0.08), new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.6 }));
    rim.position.set(0, TABLE_Y - 0.035, TABLE_Z);
    g.add(rim, felt);
    for (const [x, z] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, TABLE_Y - 0.06), rim.material);
      leg.position.set((x * TABLE_W) / 2.2, (TABLE_Y - 0.06) / 2, TABLE_Z + (z * TABLE_D) / 2.2);
      g.add(leg);
    }
    g.userData.fixed = true;
    return g;
  }

  // ---------------------------------------------------------------- the game, rebuilt on each update

  private rebuild(): void {
    const m = this.model;
    disposeObject(this.dynamic);
    this.dynamic.clear();
    this.hovered.clear();
    const cloth = this.named.get('cloth')!;
    this.hits = [cloth];
    this.named = new Map([['cloth', cloth]]);
    if (!m) return;
    const v = m.view;
    const mySide = sideOf(v.config, v.you);
    const myPlay = v.status === 'playing' && v.turn.player === v.you && v.turn.phase === 'play';

    this.buildCenter(m);
    this.buildMelds(m, mySide, -0.4, m.canAddToMelds, 'mine');
    this.buildMelds(m, 1 - mySide, -0.98, false, 'theirs');
    this.buildAvatars(m);

    if (m.coveredFor) {
      this.addPanel(`Pass the headset to ${m.coveredFor}`, [], [[`I'm ${m.coveredFor}. Show my cards`, 'reveal', () => this.actions.reveal()]]);
    } else {
      this.buildHand(m);
      this.buildStaged(m);
    }

    // Information board, above the far side of the table.
    const lines = [m.scoreLine, m.hint].filter(Boolean).join('\n');
    const board = textPanel(lines, { width: 1.0, height: 0.24, size: 0.036, align: 'left' });
    board.position.set(0, 1.8, -1.5);
    board.rotation.x = 0.12;
    this.dynamic.add(board);
    const note = m.toast ?? m.connection;
    if (note) {
      const toast = textPanel(note, { width: 0.7, height: 0.1, size: 0.024, bg: m.toast ? 'rgba(140, 30, 30, 0.95)' : 'rgba(60, 60, 60, 0.95)' });
      toast.position.set(0, 1.22, -0.75);
      toast.rotation.x = -0.15;
      toast.renderOrder = 10;
      this.dynamic.add(toast);
      this.named.set('toast', toast);
    }

    // Buttons, to the right of the hand.
    const buttons: [string, string, () => void][] = [];
    const stagedCount = m.staged.length;
    if (myPlay && (m.selected.size > 0 || stagedCount > 0)) buttons.push([stagedCount ? `Lay down (${stagedCount})` : 'Lay down', 'layDown', () => this.actions.layDown()]);
    if (m.selected.size > 0 || stagedCount > 0 || m.target) buttons.push(['Clear', 'clear', () => this.actions.clear()]);
    if (m.canSkipDiscard) buttons.push(['Skip discard', 'skip', () => this.actions.skipDiscard()]);
    if (this.session) buttons.push(['Recentre', 'recentre', () => (this.needsRecentre = true)]);
    if (this.session) buttons.push(['Leave headset view', 'exit', () => void this.session?.end()]);
    buttons.forEach(([label, name, run], i) => {
      const b = textPanel(label, { width: 0.17, height: 0.045, size: 0.02, bold: true, bg: name === 'layDown' ? '#e0b22e' : 'rgba(240,240,240,0.95)', fg: '#111' });
      if (this.session) b.position.set(0.4, 1.0 - i * 0.055, -0.3);
      else b.position.set(0.42, 0.86 - i * 0.055, -0.12);
      b.rotation.set(-0.35, -0.45, 0, 'YXZ');
      this.addHit(b, { kind: 'button', run }, `button:${name}`);
    });

    if (m.overlay) {
      const extra: [string, string, () => void][] = [];
      if (m.overlay.button === 'nextHand') extra.push(['Deal the next hand', 'nextHand', () => this.actions.nextHand()]);
      if (m.overlay.button === 'rematch') extra.push(['Play again', 'rematch', () => this.actions.rematch()]);
      extra.push(['Look at the table', 'closeOverlay', () => this.actions.closeOverlay()]);
      this.addPanel(m.overlay.title, m.overlay.lines, extra);
    }
  }

  private addPanel(title: string, lines: string[], buttons: [string, string, () => void][]): void {
    const panel = textPanel([title, ...lines].join('\n'), { width: 0.62, height: 0.06 + lines.length * 0.034, size: 0.026, border: '#e0b22e' });
    panel.position.set(0, 1.18, -0.6);
    panel.renderOrder = 11;
    this.dynamic.add(panel);
    this.named.set('panel', panel);
    buttons.forEach(([label, name, run], i) => {
      const b = textPanel(label, { width: 0.4, height: 0.05, size: 0.022, bold: true, bg: i === 0 ? '#e0b22e' : 'rgba(240,240,240,0.95)', fg: '#111' });
      b.position.set((i - (buttons.length - 1) / 2) * 0.42, 1.18 - (0.06 + lines.length * 0.034) / 2 - 0.045, -0.6);
      b.renderOrder = 12;
      this.addHit(b, { kind: 'button', run }, `button:${name}`);
    });
  }

  private addHit(obj: THREE.Object3D, hit: Hit, name?: string, parent: THREE.Object3D = this.dynamic): void {
    obj.userData.hit = hit;
    obj.userData.baseScale = obj.scale.x;
    parent.add(obj);
    this.hits.push(obj);
    if (name) this.named.set(name, obj);
  }

  private card(id: number | null, opts: { selected?: boolean; ghost?: boolean } = {}): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({
      map: id === null ? cardBack() : cardFace(id),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      color: opts.selected ? 0xfff09a : 0xffffff,
      transparent: !!opts.ghost,
      opacity: opts.ghost ? 0.8 : 1,
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), mat);
  }

  /** A card lying face up on the table, its top edge pointing away from the player. */
  private flatCard(id: number | null, x: number, z: number, layer: number): THREE.Mesh {
    const c = this.card(id);
    c.rotation.x = -Math.PI / 2;
    c.position.set(x, TABLE_Y + LIFT * (layer + 1), z);
    return c;
  }

  private buildCenter(m: TableModel): void {
    const v = m.view;
    // Stock: a squared stack of backs.
    const height = Math.max(0.002, v.stockCount * 0.0003);
    const stack = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, height, CARD_H), new THREE.MeshStandardMaterial({ color: 0xf2f2f2 }));
    stack.position.set(-0.08, TABLE_Y + height / 2, TABLE_Z);
    this.dynamic.add(stack);
    const top = this.flatCard(null, -0.08, TABLE_Z, 0);
    top.position.y = TABLE_Y + height + LIFT;
    this.addHit(top, { kind: 'stock' }, 'stock');
    stack.userData.hit = { kind: 'stock' } satisfies Hit;
    this.hits.push(stack);
    this.label(`Stock ${v.stockCount}`, -0.08, TABLE_Z - 0.075);

    // Discard pile. Where the player may look through it, the cards are spread so every index shows.
    const pile = v.pile;
    if (pile.length === 0) {
      const empty = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H), new THREE.MeshBasicMaterial({ color: 0x0a4029 }));
      empty.rotation.x = -Math.PI / 2;
      empty.position.set(0.08, TABLE_Y + LIFT, TABLE_Z);
      this.addHit(empty, { kind: 'pile' }, 'pile');
    } else {
      const shown = m.canLookThrough ? pile.slice(-20) : pile.slice(-1);
      shown.forEach((id, i) => {
        const c = this.flatCard(id, 0.08 + i * 0.016, TABLE_Z, i);
        // A frozen pile is marked, as at a real table, by a wild card turned sideways.
        if (v.pileFrozen && isWild(ALL_CARDS[id]!) && i === shown.length - 1) c.rotation.z = Math.PI / 2;
        this.addHit(c, { kind: 'pile' }, i === shown.length - 1 ? 'pile' : undefined);
      });
    }
    this.label(`Pile ${pile.length}${v.pileFrozen ? ' · frozen' : ''}`, 0.08, TABLE_Z - 0.075);
  }

  /** A small upright label standing on the table. */
  private label(text: string, x: number, z: number, width = 0.12): void {
    const l = textPanel(text, { width, height: 0.026, size: 0.016 });
    l.position.set(x, TABLE_Y + 0.016, z);
    l.rotation.x = -0.5;
    this.dynamic.add(l);
  }

  private buildMelds(m: TableModel, side: number, farZ: number, clickable: boolean, who: 'mine' | 'theirs'): void {
    const st = m.view.sides[side as 0 | 1];
    st.melds.forEach((meld, i) => {
      const x = -0.6 + i * 0.085;
      const canasta = isCanasta(meld);
      const step = canasta ? 0.006 : 0.018;
      const ids = [...meld.cardIds].sort((a, b) => Number(isWild(ALL_CARDS[a]!)) - Number(isWild(ALL_CARDS[b]!)));
      const length = CARD_H + step * (ids.length - 1);
      const color = canasta ? (isNaturalCanasta(meld) ? 0xc62828 : 0x222222) : 0x0b4a2f;
      const chosen = clickable && m.target === meld.rank;
      const base = new THREE.Mesh(
        new THREE.PlaneGeometry(CARD_W + 0.012, length + 0.012),
        new THREE.MeshBasicMaterial({ color: chosen ? 0xffd54a : color }),
      );
      base.rotation.x = -Math.PI / 2;
      base.position.set(x, TABLE_Y + LIFT * 0.5, farZ + length / 2);
      const hit: Hit | null = clickable && meld.rank !== '3' ? { kind: 'meld', rank: meld.rank } : null;
      if (hit) this.addHit(base, hit, `meld:${who}:${meld.rank}`);
      else this.dynamic.add(base);
      ids.forEach((id, j) => {
        const c = this.flatCard(id, x, farZ + CARD_H / 2 + j * step, j + 1);
        if (hit) this.addHit(c, hit);
        else this.dynamic.add(c);
      });
      this.label(`${meld.rank === '3' ? 'Black 3s' : meld.rank} ×${meld.cardIds.length}`, x, farZ - 0.022, 0.08);
    });
    st.redThrees.forEach((id, j) => this.dynamic.add(this.flatCard(id, 0.6, farZ + CARD_H / 2 + j * 0.018, j)));
  }

  private buildHand(m: TableModel): void {
    const group = new THREE.Group();
    // In a headset the fan floats in front of you like a held hand; on a screen it lies lower, at the table's edge.
    if (this.session) {
      group.position.set(0, 0.95, -0.3);
      group.rotation.x = -0.75;
    } else {
      group.position.set(0, 0.8, -0.06);
      group.rotation.x = -1.0;
    }
    this.dynamic.add(group);
    const n = m.hand.length;
    const radius = 0.38;
    const step = Math.min(0.075, 1.5 / Math.max(1, n));
    const scale = 1.25;
    m.hand.forEach((id, i) => {
      const a = (i - (n - 1) / 2) * step;
      const lift = m.selected.has(id) ? 0.028 : 0;
      const c = this.card(id, { selected: m.selected.has(id) });
      c.scale.setScalar(scale);
      c.position.set((radius + lift) * Math.sin(a), (radius + lift) * Math.cos(a) - radius, i * 0.0008);
      c.rotation.z = -a;
      this.addHit(c, { kind: 'card', id }, `card:${id}`, group);
    });
  }

  private buildStaged(m: TableModel): void {
    m.staged.forEach((p, i) => {
      const x = -0.25 + i * 0.085;
      p.cardIds.forEach((id, j) => {
        const c = this.card(id, { ghost: true });
        c.rotation.x = -1.1;
        c.position.set(x, TABLE_Y + 0.05 + j * 0.002, -0.17 + j * 0.012);
        this.dynamic.add(c);
      });
    });
    if (m.staged.length) this.label('Ready to lay down', -0.25 + ((m.staged.length - 1) * 0.085) / 2, -0.24, 0.16);
  }

  // ---------------------------------------------------------------- avatars

  /** Where each other seat sits, relative to me (seat order runs clockwise, so the next player is on my left). */
  private seatPose(rel: number, players: number): { x: number; z: number; ry: number } {
    if (players === 2 || rel === 2) return { x: 0, z: TABLE_Z - TABLE_D / 2 - 0.12, ry: 0 };
    if (rel === 1) return { x: -TABLE_W / 2 - 0.3, z: TABLE_Z, ry: Math.PI / 2 };
    return { x: TABLE_W / 2 + 0.3, z: TABLE_Z, ry: -Math.PI / 2 };
  }

  private buildAvatars(m: TableModel): void {
    const v = m.view;
    const n = v.config.players;
    const keep = new Set<number>();
    for (let rel = 1; rel < n; rel++) {
      const seat = (v.you + rel) % n;
      keep.add(seat);
      let av = this.avatars.get(seat);
      if (!av) {
        av = this.makeAvatar(SEAT_COLORS[seat % SEAT_COLORS.length]!);
        this.avatars.set(seat, av);
        this.tableRoot.add(av.root);
      }
      const pose = this.seatPose(rel, n);
      av.root.position.set(pose.x, 0, pose.z);
      av.root.rotation.y = pose.ry;
      const online = m.seatOnline[seat] ?? false;
      av.root.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (mat && 'opacity' in mat && o.userData.avatarPart) {
          mat.transparent = !online;
          mat.opacity = online ? 1 : 0.35;
        }
      });

      // The parts below change with the game, so they live in the rebuilt group, parented to the seat.
      const seatGroup = new THREE.Group();
      seatGroup.position.copy(av.root.position);
      seatGroup.rotation.copy(av.root.rotation);
      this.dynamic.add(seatGroup);
      const turn = v.status === 'playing' && v.turn.player === seat;
      const tag = textPanel(`${m.seatNames[seat] ?? `Seat ${seat + 1}`}${online ? '' : ' (away)'}`, {
        width: 0.26,
        height: 0.05,
        size: 0.024,
        bold: true,
        bg: turn ? '#e0b22e' : 'rgba(10,30,20,0.85)',
        fg: turn ? '#111' : '#fff',
      });
      tag.position.set(0, 1.48, 0);
      seatGroup.add(tag);
      // Their hand, backs towards me, held in front of the body.
      const count = v.handSizes[seat] ?? 0;
      const shown = Math.min(count, 15);
      const fan = new THREE.Group();
      fan.position.set(0, 0.95, 0.28);
      fan.rotation.x = 0.35;
      seatGroup.add(fan);
      for (let i = 0; i < shown; i++) {
        const a = (i - (shown - 1) / 2) * 0.06;
        const c = this.card(null);
        c.scale.setScalar(0.9);
        c.position.set(0.2 * Math.sin(a), 0.2 * Math.cos(a) - 0.2, -i * 0.0008);
        c.rotation.z = a;
        fan.add(c);
      }
      const countTag = textPanel(`${count} cards`, { width: 0.1, height: 0.026, size: 0.015 });
      countTag.position.set(0, 1.08, 0.3);
      seatGroup.add(countTag);
    }
    for (const [seat, av] of this.avatars) {
      if (!keep.has(seat)) {
        this.tableRoot.remove(av.root);
        disposeObject(av.root);
        this.avatars.delete(seat);
      }
    }
  }

  private makeAvatar(color: number): AvatarParts {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const part = (geo: THREE.BufferGeometry, c: number) => {
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));
      mesh.userData.avatarPart = true;
      return mesh;
    };
    const torso = part(new THREE.CapsuleGeometry(0.15, 0.3, 6, 16), color);
    torso.position.y = 0.93;
    const head = part(new THREE.SphereGeometry(0.1, 24, 16), 0xe8c4a0);
    head.position.y = 1.3;
    const nose = part(new THREE.SphereGeometry(0.018, 10, 8), 0xd9a882);
    nose.position.set(0, 0, 0.1);
    head.add(nose);
    const left = part(new THREE.SphereGeometry(0.04, 16, 12), 0xe8c4a0);
    const right = part(new THREE.SphereGeometry(0.04, 16, 12), 0xe8c4a0);
    left.position.set(-0.13, 0.86, 0.26);
    right.position.set(0.13, 0.86, 0.26);
    const chair = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.05, 0.45), new THREE.MeshStandardMaterial({ color: 0x5a3a22 }));
    chair.position.set(0, 0.45, -0.05);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.55, 0.04), chair.material);
    back.position.set(0, 0.72, -0.27);
    body.add(torso, head, left, right);
    root.add(chair, back);
    return { root, body, head, left, right, reach: null };
  }

  /** Phones send no movements, so avatars act out the moves the game reports: drawing, discarding, taking the pile. */
  private animateAvatarsFromChanges(): void {
    const now = this.model?.view;
    const before = this.previous?.view;
    if (!now || !before || now.handNumber !== before.handNumber) return;
    const actor = before.turn.player;
    const av = this.avatars.get(actor);
    if (!av) return;
    const target = new THREE.Vector3();
    if (now.stockCount < before.stockCount) target.set(-0.08, TABLE_Y + 0.03, TABLE_Z);
    else if (now.pile.length !== before.pile.length) target.set(0.08, TABLE_Y + 0.03, TABLE_Z);
    else if (now.sides.some((s, i) => s.melds.length !== before.sides[i]!.melds.length)) target.set(0, TABLE_Y + 0.03, TABLE_Z - 0.3);
    else return;
    this.tableRoot.localToWorld(target);
    av.root.worldToLocal(target);
    av.reach = { to: target, start: this.clock.getElapsedTime() };
  }

  private animateAvatars(t: number): void {
    const v = this.model?.view;
    for (const [seat, av] of this.avatars) {
      const turn = !!v && v.status === 'playing' && v.turn.player === seat;
      // Lean in and look at the table on your turn; otherwise sit back and breathe.
      const lean = turn ? 0.18 : 0.02;
      av.body.rotation.x += (lean - av.body.rotation.x) * 0.06;
      av.body.position.y = Math.sin(t * 1.3 + seat) * 0.006;
      av.head.rotation.x = turn ? 0.35 : 0.1 + Math.sin(t * 0.5 + seat) * 0.05;
      av.head.rotation.y = Math.sin(t * 0.37 + seat * 2) * 0.25;
      const rest = new THREE.Vector3(0.13, 0.86, 0.26);
      if (av.reach) {
        const k = (t - av.reach.start) / 0.9;
        if (k >= 1) av.reach = null;
        else {
          const out = Math.sin(Math.PI * k);
          av.right.position.lerpVectors(rest, av.reach.to, out);
          continue;
        }
      }
      av.right.position.copy(rest);
    }
  }

  // ---------------------------------------------------------------- input

  private setupControllers(): void {
    for (let i = 0; i < 2; i++) {
      const ray = this.renderer.xr.getController(i);
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
      line.scale.z = 2;
      ray.add(line);
      const entry = { ray, line, source: null as XRInputSource | null };
      ray.addEventListener('connected', (e) => (entry.source = (e as unknown as { data: XRInputSource }).data));
      ray.addEventListener('disconnected', () => (entry.source = null));
      ray.addEventListener('select', () => this.tapFrom(ray));
      this.scene.add(ray);
      this.controllers.push(entry);

      const hand = this.renderer.xr.getHand(i);
      this.scene.add(hand);
      this.hands.push({ hand, armed: true });
    }
  }

  private rayFrom(obj: THREE.Object3D): THREE.Intersection | undefined {
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3(0, 0, -1);
    obj.getWorldPosition(origin);
    dir.applyQuaternion(obj.getWorldQuaternion(new THREE.Quaternion()));
    this.raycaster.set(origin, dir);
    return this.raycaster.intersectObjects(this.hits, false)[0];
  }

  private tapFrom(obj: THREE.Object3D): void {
    const hit = this.rayFrom(obj);
    if (hit) this.run(hit.object.userData.hit as Hit);
  }

  private run(hit: Hit): void {
    switch (hit.kind) {
      case 'card':
        return this.actions.tapCard(hit.id);
      case 'meld':
        return this.actions.tapMeld(hit.rank);
      case 'stock':
        return this.actions.tapStock();
      case 'pile':
        return this.actions.tapPile();
      case 'cloth':
        return this.actions.tapCloth();
      case 'button':
        return hit.run();
    }
  }

  private screenHit(e: PointerEvent): THREE.Intersection | undefined {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(this.hits, false)[0];
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12) return;
    const hit = this.screenHit(e);
    if (hit) this.run(hit.object.userData.hit as Hit);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    const hit = this.screenHit(e);
    this.setHover(hit && hit.object.userData.hit.kind !== 'cloth' ? [hit.object] : []);
    this.renderer.domElement.style.cursor = hit && hit.object.userData.hit.kind !== 'cloth' ? 'pointer' : '';
  };

  private onPointerLeave = (): void => this.setHover([]);

  /** Hover makes a thing slightly bigger. It never moves it, so a resting pointer cannot make it flicker. */
  private setHover(objs: THREE.Object3D[]): void {
    const next = new Set(objs);
    for (const o of this.hovered) if (!next.has(o)) o.scale.setScalar(o.userData.baseScale ?? 1);
    for (const o of next) o.scale.setScalar((o.userData.baseScale ?? 1) * 1.07);
    this.hovered = next;
  }

  /** Fingertip touch: tapping a card in the fan (or a button) with the index finger, no controller needed. */
  private pokeHands(): void {
    const tip = new THREE.Vector3();
    const local = new THREE.Vector3();
    for (const h of this.hands) {
      const joint = (h.hand as THREE.Group & { joints?: Record<string, THREE.Object3D> }).joints?.['index-finger-tip'];
      if (!joint || !joint.visible) continue;
      joint.getWorldPosition(tip);
      let best: THREE.Object3D | null = null;
      let bestOrder = -Infinity;
      for (const o of this.hits) {
        const hit = o.userData.hit as Hit;
        if (hit.kind !== 'card' && hit.kind !== 'button') continue;
        const mesh = o as THREE.Mesh;
        const geo = mesh.geometry as THREE.PlaneGeometry;
        const { width, height } = geo.parameters;
        local.copy(tip);
        mesh.worldToLocal(local);
        if (Math.abs(local.z) < 0.012 && Math.abs(local.x) < width / 2 && Math.abs(local.y) < height / 2) {
          // The card on top wins: later cards in the fan lie over earlier ones.
          const order = mesh.position.z;
          if (order > bestOrder) {
            best = o;
            bestOrder = order;
          }
        }
      }
      if (best && h.armed) {
        h.armed = false;
        this.run(best.userData.hit as Hit);
        this.buzz(0.2);
      } else if (!best) h.armed = true;
    }
  }

  private drawHandJoints(): void {
    for (const h of this.hands) {
      const joints = (h.hand as THREE.Group & { joints?: Record<string, THREE.Object3D> }).joints;
      if (!joints) continue;
      for (const [name, joint] of Object.entries(joints)) {
        if (joint.userData.dot) continue;
        const r = name.endsWith('tip') ? 0.007 : 0.009;
        const dot = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshStandardMaterial({ color: name === 'index-finger-tip' ? 0xffd54a : 0xf0d6c0 }));
        joint.add(dot);
        joint.userData.dot = true;
      }
    }
  }

  private buzz(strength = 0.6): void {
    for (const c of this.controllers) {
      const actuator = (c.source?.gamepad as (Gamepad & { hapticActuators?: { pulse(v: number, ms: number): void }[] }) | undefined)?.hapticActuators?.[0];
      try {
        actuator?.pulse(strength, 60);
      } catch {
        // not every controller can vibrate
      }
    }
  }

  private recentre(): void {
    const cam = this.renderer.xr.getCamera();
    const pos = new THREE.Vector3();
    cam.getWorldPosition(pos);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const yaw = Math.atan2(-dir.x, -dir.z);
    this.tableRoot.position.set(pos.x, pos.y - EYE_Y, pos.z);
    this.tableRoot.rotation.set(0, yaw, 0);
  }

  // ---------------------------------------------------------------- loop

  private resize(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    if (this.renderer.xr.isPresenting) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // On a narrow phone-shaped window, step back a little so the whole table fits.
    this.camera.fov = w / h < 1 ? 84 : 66;
    this.camera.updateProjectionMatrix();
  }

  private frame = (): void => {
    const t = this.clock.getElapsedTime();
    if (this.renderer.xr.isPresenting) {
      this.framesInSession++;
      // Wait a few frames for the headset pose before putting the table in front of the player.
      if (this.needsRecentre && this.framesInSession > 5) {
        this.recentre();
        this.needsRecentre = false;
      }
      const rayHits: THREE.Object3D[] = [];
      for (const c of this.controllers) {
        const hit = c.source ? this.rayFrom(c.ray) : undefined;
        c.line.scale.z = hit ? hit.distance : 2;
        if (hit && (hit.object.userData.hit as Hit).kind !== 'cloth') rayHits.push(hit.object);
      }
      this.setHover(rayHits);
      this.drawHandJoints();
      this.pokeHands();
    }
    this.animateAvatars(t);
    this.renderer.render(this.scene, this.camera);
  };
}
