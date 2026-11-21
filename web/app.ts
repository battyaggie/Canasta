import {
  ALL_CARDS,
  type Meld,
  type MeldPlay,
  type PlayerView,
  cardPoints,
  initialMeldMinimum,
  isCanasta,
  isNaturalCanasta,
  isWild,
  playersOfSide,
  sideOf,
  sumPoints,
} from '../engine/src/index.js';
import type { ClientMsg, Figure, Mode, RoomInfo, RoomSummary, ServerMsg } from '../shared/protocol.js';
import { cardBack, cardEl, cardLabel, handGroup, sortHand } from './cardview.js';
import { h } from './dom.js';
import { LocalTransport, clearSavedLocal, loadSavedLocal, type Status, type Transport, WsTransport } from './transport.js';
import { Voice } from './voice.js';
import type { Table3D, TableActions, TableModel } from './xr/table3d.js';

// ------------------------------------------------------------------ state

const appEl = document.getElementById('app')!;

let transport: Transport | null = null;
let isLocal = false;
let roomCode = '';
let you = -1;
let room: RoomInfo | null = null;
let view: PlayerView | null = null;
let status: Status = 'closed';
let joined = false;
let fatal: string | null = null;
let covered = false; // pass & play: hide cards until the next player says they're ready
let overlayOpen = false;
let lastOverlayKey = '';
let toastText: string | null = null;
let toastTimer: number | undefined;
/** Voice chat at an online table (null in pass & play and against the computer). */
let voice: Voice | null = null;
/** Voice starts by itself once per table at live tables; after that only the mic button starts it. */
let voiceAutoTried = false;

const selected = new Set<number>();
/** Cards that came into my hand this turn (drawn, or picked up with the pile), shown highlighted until the turn ends. */
const fresh = new Set<number>();
let staged: MeldPlay[] = [];
/** A meld on the table the player has tapped: cards tapped in the hand now go straight onto it. */
let target: MeldPlay['rank'] | null = null;

/** The 3D table (three.js, loaded only when someone asks for it). */
let table3d: Table3D | null = null;
/** A new version of the app has arrived; it loads at the start page. */
let updateReady = false;
/** The new version's service worker, waiting for the go-ahead. */
let waitingWorker: ServiceWorker | null = null;
let applyingUpdate = false;

/** Switch to the new version: let its service worker take over, then reload (or just reload if it already has). */
function applyUpdate(): void {
  if (applyingUpdate) return;
  applyingUpdate = true;
  if (waitingWorker) waitingWorker.postMessage('skipWaiting');
  else location.reload();
}
let in3d = false;
let xr = { vr: false, ar: false };
const host3d = h('div', { class: 'three-host', id: 'three-host' });

const form = {
  name: safeGet('canasta.name') ?? '',
  figure: (safeGet('canasta.figure') === 'woman' ? 'woman' : safeGet('canasta.figure') === 'man' ? 'man' : '') as Figure | '',
  players: '2',
  mode: 'live' as Mode,
  target: '5000',
  botLevel: 'normal' as 'easy' | 'normal',
  joinCode: '',
  error: '',
  /** A started game this device has no seat at: "Which player are you?" */
  claim: null as { code: string; seats: { name: string; connected: boolean }[] } | null,
};

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* private mode etc. */
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

// ------------------------------------------------------------------ saved online games
//
// The server keeps every table, with its cards and scores, for 90 days after the last move, even
// when nobody is connected. This device remembers which tables it sits at (and its secret seat token
// for each), so the start page can offer "Continue" for each unfinished game: no code to type.

const MAX_SAVED = 6;

/** Tables this device has a seat at, most recently played first. */
function savedTables(): string[] {
  let list: string[] = [];
  try {
    const raw: unknown = JSON.parse(safeGet('canasta.rooms') ?? '[]');
    if (Array.isArray(raw)) list = raw.filter((c): c is string => typeof c === 'string' && /^[A-Z0-9]{4}$/.test(c));
  } catch {
    /* unreadable: start a fresh list */
  }
  const last = safeGet('canasta.lastRoom'); // remembered by earlier versions of the app
  if (last && !list.includes(last)) list.unshift(last);
  return list.filter((c) => safeGet(`canasta.token.${c}`));
}

function rememberTable(code: string): void {
  safeSet('canasta.rooms', JSON.stringify([code, ...savedTables().filter((c) => c !== code)].slice(0, MAX_SAVED)));
  safeSet('canasta.lastRoom', code);
}

function forgetTable(code: string): void {
  safeSet('canasta.rooms', JSON.stringify(savedTables().filter((c) => c !== code)));
  if (safeGet('canasta.lastRoom') === code) safeRemove('canasta.lastRoom');
  summaries.delete(code);
}

/** What the server says about each saved table; 'loading' while we ask. Asked afresh each time the start page opens. */
const summaries = new Map<string, RoomSummary | 'loading' | 'offline'>();

function loadSummary(code: string): void {
  if (summaries.has(code)) return;
  summaries.set(code, 'loading');
  fetch(`/api/room/${code}`)
    .then(async (res) => {
      if (res.status === 404) return forgetTable(code); // the table has been tidied away
      if (!res.ok) throw new Error(String(res.status));
      const sum = (await res.json()) as RoomSummary;
      if (sum.phase === 'finished') return forgetTable(code); // played to the end: nothing to continue
      summaries.set(code, sum);
    })
    .catch(() => summaries.set(code, 'offline'))
    .finally(() => !transport && render());
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min} minutes ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const listNames = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** "Your game with Mum" and "Hand 3 · You 2,340, Mum 1,980 · last played 2 days ago". */
function describeSaved(code: string, sum: RoomSummary | 'loading' | 'offline' | undefined): { title: string; detail: string } {
  if (!sum || sum === 'loading') return { title: `Table ${code}`, detail: 'Looking up the game…' };
  if (sum === 'offline') return { title: `Table ${code}`, detail: 'Could not reach the server just now.' };
  const mine = Number(safeGet(`canasta.seat.${code}`));
  const known = Number.isInteger(mine) && safeGet(`canasta.seat.${code}`) !== null && mine < sum.seats.length;
  const others = sum.seats.filter((_, i) => !known || i !== mine).map((s) => s.name);
  const title = known && others.length ? `Your game with ${listNames(others)}` : `Table ${code}`;
  const bits: string[] = [];
  if (sum.phase === 'lobby') bits.push('Not started yet');
  else if (sum.scores) {
    const fmt = (n: number) => n.toLocaleString('en');
    if (sum.settings.players === 2 && known) {
      const me = mine % 2;
      bits.push(`Hand ${sum.handNumber}`, `You ${fmt(sum.scores[me as 0 | 1])}, ${others[0]} ${fmt(sum.scores[(1 - me) as 0 | 1])}`);
    } else if (known) {
      const me = mine % 2;
      bits.push(`Hand ${sum.handNumber}`, `Your side ${fmt(sum.scores[me as 0 | 1])}, the others ${fmt(sum.scores[(1 - me) as 0 | 1])}`);
    } else bits.push(`Hand ${sum.handNumber}`, `${fmt(sum.scores[0])} to ${fmt(sum.scores[1])}`);
  }
  if (sum.lastMoveAt) bits.push(`last played ${ago(sum.lastMoveAt)}`);
  const here = sum.seats.filter((s, i) => s.connected && (!known || i !== mine)).map((s) => s.name);
  if (here.length) bits.push(`${listNames(here)} ${here.length === 1 ? 'is' : 'are'} at the table now`);
  return { title, detail: bits.join(' · ') };
}

// ------------------------------------------------------------------ connection

function showToast(text: string): void {
  toastText = text;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastText = null;
    render();
  }, 4000);
  render();
}

function resetGameState(): void {
  you = -1;
  room = null;
  view = null;
  joined = false;
  fatal = null;
  covered = false;
  overlayOpen = false;
  lastOverlayKey = '';
  selected.clear();
  staged = [];
  target = null;
}

function handleMessage(msg: ServerMsg): void {
  if (msg.t === 'welcome') {
    joined = true;
    if (!isLocal) {
      safeSet(`canasta.token.${roomCode}`, msg.token);
      safeSet(`canasta.seat.${roomCode}`, String(msg.seat));
    }
    voice?.rejoined();
    return;
  }
  if (msg.t === 'signal') {
    voice?.handleSignal(msg.from, msg.data);
    return;
  }
  if (msg.t === 'error') {
    if (!joined) {
      fatal = msg.message;
      transport?.close();
      render();
    } else showToast(msg.message);
    return;
  }
  const previousSeat = you;
  const previousStatus = view?.status;
  const previous = view;
  you = msg.you;
  room = msg.room;
  view = msg.view;
  if (voice) {
    voice.update(you, room);
    // Live tables: join the voice chat straight away (the browser asks once for the microphone).
    if (!voiceAutoTried && room.settings.mode === 'live' && safeGet('canasta.voice') !== 'off') {
      voiceAutoTried = true;
      void voice.start();
    }
  }
  // Pass & play: hide the cards whenever the turn moves to someone else, and at the start of each hand.
  // Not against the computer: there is only one person at the screen.
  if (isLocal && !vsComputer() && view?.status === 'playing' && (previousSeat !== you || previousStatus !== 'playing')) covered = true;
  reconcileSelection();
  trackFresh(previous, previousSeat);
  const key = view ? `${view.handNumber}:${view.status}` : '';
  if (key !== lastOverlayKey) {
    lastOverlayKey = key;
    overlayOpen = view?.status === 'handOver' || view?.status === 'gameOver';
  }
  render();
}

/** Remember which cards just came into my hand, so the hand can point them out. */
function trackFresh(before: PlayerView | null, seatBefore: number): void {
  const v = view;
  const myTurn = !!v && v.status === 'playing' && v.turn.player === you;
  if (!v || !myTurn || !before || seatBefore !== you || before.handNumber !== v.handNumber) {
    fresh.clear();
    return;
  }
  const had = new Set(before.myHand);
  for (const id of v.myHand) if (!had.has(id)) fresh.add(id);
  const mine = new Set(v.myHand);
  for (const id of fresh) if (!mine.has(id)) fresh.delete(id);
}

/** Forget selections of cards that have left my hand (e.g. after a successful meld). */
function reconcileSelection(): void {
  const mine = new Set(view?.myHand ?? []);
  for (const id of [...selected]) if (!mine.has(id)) selected.delete(id);
  if (!staged.every((p) => p.cardIds.every((id) => mine.has(id)))) staged = [];
  // The chosen meld only stays chosen while it is still my turn to play.
  const myPlay = !!view && view.status === 'playing' && view.turn.player === you && view.turn.phase === 'play';
  const side = view ? view.sides[sideOf(view.config, you) as 0 | 1] : null;
  if (!myPlay || !side?.melds.some((m) => m.rank === target)) target = null;
}

function openTransport(
  t: (events: { onMessage: typeof handleMessage; onStatus: (s: Status) => void; onNote: (text: string) => void }) => Transport,
): void {
  resetGameState();
  stopVoice();
  transport?.close();
  transport = t({
    onMessage: handleMessage,
    onStatus: (s) => {
      status = s;
      render();
    },
    onNote: showToast,
  });
}

/** `claimSeat`: this device has no seat token for a started game, and the person said which player they are. */
async function joinOnline(code: string, name: string, tokenFromLink?: string, claimSeat?: number): Promise<void> {
  code = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    form.error = 'Table codes have 4 letters or digits.';
    return render();
  }
  form.error = '';
  form.claim = null;
  try {
    const res = await fetch(`/api/room/${code}`);
    if (res.status === 404) {
      forgetTable(code);
      form.error = `There is no table with the code ${code}.`;
      return render();
    }
    const sum = (await res.json()) as Partial<RoomSummary>;
    // A game that has already started, on a device that does not know its seat (a new phone, the
    // headset instead of the computer, or the browser forgot): ask which player this is.
    if (sum.phase !== 'lobby' && Array.isArray(sum.seats) && !tokenFromLink && !safeGet(`canasta.token.${code}`) && claimSeat === undefined) {
      form.claim = { code, seats: sum.seats };
      return render();
    }
    // Sitting down at a table that has not started yet: the others need to know who you are.
    if (sum.phase === 'lobby' && !name && !tokenFromLink && !safeGet(`canasta.token.${code}`)) {
      form.error = 'Please enter your name first.';
      return render();
    }
  } catch {
    form.error = 'Could not reach the server.';
    return render();
  }
  isLocal = false;
  roomCode = code;
  if (tokenFromLink) safeSet(`canasta.token.${code}`, tokenFromLink);
  // Remembered so the start page can offer "Continue" for this game, days later.
  rememberTable(code);
  history.replaceState(null, '', `?room=${code}`);
  if (name) safeSet('canasta.name', name);
  openTransport(
    (events) =>
      new WsTransport(code, events, () => {
        const token = safeGet(`canasta.token.${code}`) ?? undefined;
        return {
          t: 'hello',
          token,
          name: name || safeGet('canasta.name') || undefined,
          ...(form.figure ? { figure: form.figure } : {}),
          ...(!token && claimSeat !== undefined ? { seat: claimSeat } : {}),
        };
      }),
  );
  voice = new Voice(send, render, showSpeaking);
  voiceAutoTried = false;
  (window as unknown as { canastaVoice?: Voice }).canastaVoice = voice; // lets the browser tests look inside
  render();
}

async function createTable(): Promise<void> {
  const name = form.name.trim();
  if (!name) {
    form.error = 'Please enter your name first.';
    return render();
  }
  form.error = '';
  try {
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ players: Number(form.players), mode: form.mode, targetScore: Number(form.target) }),
    });
    const body = (await res.json()) as { code?: string; error?: string };
    if (!res.ok || !body.code) {
      form.error = body.error ?? 'Could not create the table.';
      return render();
    }
    await joinOnline(body.code, name);
  } catch {
    form.error = 'Could not reach the server. (Pass & play still works offline.)';
    render();
  }
}

function startLocal(players: 2 | 4, resume = false, vsComp = false): void {
  const saved = resume ? loadSavedLocal() : null;
  isLocal = true;
  roomCode = 'LOCAL';
  const vs = vsComp ? { level: form.botLevel, name: form.name.trim() || undefined } : undefined;
  openTransport((events) => new LocalTransport(saved?.settings.players ?? players, events, saved, vs));
  render();
}

/** Playing against computer players on this device. */
const vsComputer = (): boolean => isLocal && !!room?.settings.bots?.length;

function leave(): void {
  exit3d(false);
  stopVoice();
  transport?.close();
  transport = null;
  resetGameState();
  isLocal = false;
  roomCode = '';
  summaries.clear(); // look up the saved games afresh: scores have moved on
  history.replaceState(null, '', location.pathname);
  render();
}

const send = (msg: ClientMsg): void => transport?.send(msg);

// ------------------------------------------------------------------ voice chat

function stopVoice(): void {
  voice?.close();
  voice = null;
}

/** The microphone button: join voice, mute, unmute, or explain why it is not working. */
function tapMic(): void {
  if (!voice) return;
  if (voice.state === 'off') {
    safeSet('canasta.voice', 'on');
    void voice.start();
  } else if (voice.state === 'starting') {
    void voice.start(true);
  } else if (voice.state === 'blocked') {
    showToast('The microphone is blocked. Allow it for this site in the browser settings, then tap the button again.');
    void voice.start();
  } else voice.toggleMute();
}

function micLabel(): string | null {
  if (!voice) return null;
  if (voice.needsTap) return '🔈 Tap to hear the others';
  switch (voice.state) {
    case 'off':
      return '🎤 Join voice chat';
    case 'starting':
      return voice.stuck ? '🎤 Tap to turn on voice' : '🎤 Starting…';
    case 'on':
      return '🎤 Mic on';
    case 'muted':
      return '🔇 Muted';
    case 'blocked':
      return '🎤 Microphone off';
  }
}

function micButton(): HTMLElement | null {
  const label = micLabel();
  if (!label) return null;
  const state = voice!.state;
  const title = state === 'on' ? 'Tap to mute your microphone' : state === 'muted' ? 'Tap to let the others hear you again' : 'Talk to the other players';
  return h('button', { class: `small-btn mic mic-${voice!.needsTap || voice!.stuck ? 'tap' : state}`, id: 'mic', title, 'aria-pressed': String(state === 'on'), onclick: tapMic }, label);
}

/** Light up the name of whoever is talking, without redrawing the whole screen. */
function showSpeaking(speaking: ReadonlySet<number>): void {
  document.querySelectorAll<HTMLElement>('[data-seat]').forEach((el) => {
    el.classList.toggle('speaking', speaking.has(Number(el.dataset.seat)));
  });
}

const voiceTag = (seat: number): HTMLElement | null =>
  !isLocal && room?.seats[seat]?.voice && room.seats[seat]?.connected ? h('span', { class: 'tag voice', title: 'in the voice chat' }, '🎤') : null;

// ------------------------------------------------------------------ meld building

type RankResult = { rank: MeldPlay['rank'] } | { error: string };

function rankOfSelection(ids: number[], meldRank?: MeldPlay['rank']): RankResult {
  const cards = ids.map((id) => ALL_CARDS[id]!);
  if (cards.some((c) => c.rank === '3' && (c.suit === 'H' || c.suit === 'D'))) {
    return { error: 'Red threes are laid down automatically and cannot be melded.' };
  }
  const naturals = cards.filter((c) => !isWild(c));
  // Wild cards alone are fine when they are being added to a meld that is already on the table.
  if (naturals.length === 0 && meldRank) return { rank: meldRank };
  if (naturals.length === 0) {
    return { error: 'Wild cards need a natural card with them. To add them to a meld you already have, tap that meld on the table, then press Meld.' };
  }
  const ranks = new Set(naturals.map((c) => c.rank));
  if (ranks.size > 1) return { error: 'One meld can only contain one rank (plus wild cards).' };
  const rank = naturals[0]!.rank as MeldPlay['rank'];
  if (rank === '3' && cards.some(isWild)) return { error: 'Black threes cannot be melded with wild cards.' };
  return { rank };
}

function stageSelection(rankOverride?: MeldPlay['rank']): boolean {
  const ids = [...selected];
  if (ids.length === 0) {
    showToast('Select some cards from your hand first.');
    return false;
  }
  const result = rankOfSelection(ids, rankOverride);
  if ('error' in result) {
    showToast(result.error);
    return false;
  }
  if (rankOverride && rankOverride !== result.rank) {
    showToast(`Those cards don't match a meld of ${rankOverride}s.`);
    return false;
  }
  const existing = staged.find((p) => p.rank === result.rank);
  if (existing) existing.cardIds.push(...ids);
  else staged.push({ rank: result.rank, cardIds: ids });
  selected.clear();
  render();
  return true;
}

/** Tap a meld on the table. With cards already selected they are set aside for it; otherwise the meld is chosen, and cards tapped next go straight onto it. */
function tapMeld(rank: MeldPlay['rank']): void {
  if (selected.size > 0) {
    stageSelection(rank);
    return;
  }
  target = target === rank ? null : rank;
  render();
}

/** A card tapped in the hand while a meld is chosen: add it to that meld straight away. */
function addToTarget(id: number): void {
  const card = ALL_CARDS[id]!;
  if (card.rank === '3' && (card.suit === 'H' || card.suit === 'D')) return void showToast('Red threes are laid down automatically and cannot be melded.');
  if (!isWild(card) && card.rank !== target) return void showToast(`That card doesn't fit the ${rankText(target!)} meld. Use the same rank, a Joker or a 2.`);
  send({ t: 'action', action: { type: 'meld', melds: [{ rank: target!, cardIds: [id] }] } });
}

const stagedIds = (): Set<number> => new Set(staged.flatMap((p) => p.cardIds));

function layDown(): void {
  if (selected.size > 0 && !stageSelection()) return;
  if (staged.length === 0) return showToast('Select cards and press Meld.');
  send({ t: 'action', action: { type: 'meld', melds: staged } });
}

function takePile(): void {
  if (!view || view.pile.length === 0) return;
  const topId = view.pile[view.pile.length - 1]!;
  const top = ALL_CARDS[topId]!;
  const plays = staged.map((p) => ({ rank: p.rank, cardIds: [...p.cardIds] }));
  if (selected.size > 0) {
    const result = rankOfSelection([...selected]);
    if ('error' in result) return showToast(result.error);
    if (result.rank !== top.rank) return showToast(`Your selected cards must match the top card (${top.rank}).`);
    const existing = plays.find((p) => p.rank === result.rank);
    if (existing) existing.cardIds.push(...selected);
    else plays.push({ rank: result.rank, cardIds: [...selected] });
  }
  send({ t: 'action', action: { type: 'takePile', melds: plays } });
}

function discard(): void {
  if (selected.size !== 1) return showToast('Select exactly one card to discard.');
  send({ t: 'action', action: { type: 'discard', cardId: [...selected][0]! } });
}

function clearSelection(): void {
  selected.clear();
  target = null;
  staged = [];
  render();
}

// ------------------------------------------------------------------ helpers for display

const seatName = (seat: number): string => room?.seats[seat]?.name ?? `Seat ${seat + 1}`;

function sideLabel(side: number): string {
  if (!view) return '';
  const cfg = view.config;
  const mine = side === sideOf(cfg, view.you);
  if (cfg.players === 2) return mine ? 'You' : seatName(1 - view.you);
  return mine ? 'Us' : 'Them';
}

function sideNames(side: number): string {
  if (!view) return '';
  return playersOfSide(view.config, side).map(seatName).join(' & ');
}

function timeAgo(ms: number | null): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function rankText(rank: string): string {
  return rank === '3' ? 'Black 3s' : rank;
}

// ------------------------------------------------------------------ screens

function renderHome(): HTMLElement {
  const params = new URLSearchParams(location.search);
  const linkCode = (params.get('room') ?? '').toUpperCase();
  if (linkCode && !form.joinCode) form.joinCode = linkCode;
  const personal = params.get('t');

  const nameInput = h('input', {
    type: 'text',
    id: 'name',
    maxlength: '20',
    placeholder: 'Your name',
    value: form.name,
    autocomplete: 'nickname',
    oninput: (e: Event) => (form.name = (e.target as HTMLInputElement).value),
  });
  const codeInput = h('input', {
    type: 'text',
    id: 'code',
    maxlength: '4',
    placeholder: 'ABCD',
    class: 'code-input',
    value: form.joinCode,
    autocapitalize: 'characters',
    oninput: (e: Event) => (form.joinCode = (e.target as HTMLInputElement).value.toUpperCase()),
  });

  const select = (id: string, value: string, set: (v: string) => void, options: [string, string][]) =>
    h(
      'select',
      { id, onchange: (e: Event) => set((e.target as HTMLSelectElement).value) },
      ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
    );

  return h(
    'div',
    { class: 'home' },
    h('h1', {}, 'Canasta'),
    h('p', { class: 'tagline' }, 'Play with friends and family, online or around one device.'),
    form.error ? h('p', { class: 'form-error', role: 'alert' }, form.error) : null,

    // "Which player are you?" for a started game this device has no seat at.
    form.claim
      ? h(
          'section',
          { class: 'panel rejoin', id: 'claim-panel' },
          h('h2', {}, `Table ${form.claim.code}: which player are you?`),
          h('p', { class: 'muted' }, 'This game has already started. Tap your name to sit back down in your seat with your cards.'),
          h(
            'div',
            { class: 'row buttons' },
            ...form.claim.seats.map((seat, i) =>
              h(
                'button',
                {
                  class: seat.connected ? 'claim-seat' : 'primary claim-seat',
                  disabled: seat.connected,
                  onclick: () => void joinOnline(form.claim!.code, form.name.trim(), undefined, i),
                },
                seat.connected ? `${seat.name} (playing now)` : seat.name,
              ),
            ),
            h('button', { id: 'claim-cancel', onclick: () => ((form.claim = null), render()) }, 'Cancel'),
          ),
        )
      : null,

    // Unfinished online games this device sits at: one tap to carry on, days or weeks later.
    (() => {
      const tables = linkCode || form.claim ? [] : savedTables();
      tables.forEach(loadSummary);
      const shown = tables.filter((c) => summaries.has(c)); // finished or vanished tables drop out of the list
      if (!shown.length) return null;
      return h(
        'section',
        { class: 'panel rejoin', id: 'rejoin-panel' },
        h('h2', {}, shown.length === 1 ? 'Your unfinished game' : 'Your unfinished games'),
        ...shown.map((code, i) => {
          const d = describeSaved(code, summaries.get(code));
          return h(
            'div',
            { class: 'saved-game', 'data-code': code },
            h('p', { class: 'saved-title' }, h('strong', {}, d.title), d.title.includes(code) ? null : h('span', { class: 'rejoin-code muted' }, ` (table ${code})`)),
            h('p', { class: 'muted saved-detail' }, d.detail),
            h(
              'div',
              { class: 'row buttons' },
              h('button', { ...(i === 0 ? { id: 'rejoin' } : {}), class: 'primary continue', onclick: () => void joinOnline(code, form.name.trim()) }, 'Continue this game'),
              h('button', { ...(i === 0 ? { id: 'forget-last' } : {}), class: 'forget', onclick: () => (forgetTable(code), render()) }, 'Remove from list'),
            ),
          );
        }),
      );
    })(),

    h(
      'section',
      { class: 'panel' },
      h('h2', {}, 'Your name'),
      nameInput,
      h(
        'label',
        { class: 'figure-choice' },
        'At the 3D table, show me as: ',
        select('figure', form.figure, (v) => {
          form.figure = v === 'man' || v === 'woman' ? v : '';
          safeSet('canasta.figure', form.figure);
        }, [
          ['', 'Not chosen'],
          ['woman', 'A woman'],
          ['man', 'A man'],
        ]),
      ),
    ),

    h(
      'section',
      { class: 'panel' },
      h('h2', {}, 'Start a new table'),
      h(
        'div',
        { class: 'row' },
        h('label', { for: 'players' }, 'Players'),
        select('players', form.players, (v) => (form.players = v), [
          ['2', '2 players (each for themselves)'],
          ['4', '4 players (two partnerships)'],
        ]),
      ),
      h(
        'div',
        { class: 'row' },
        h('label', { for: 'mode' }, 'Style'),
        select('mode', form.mode, (v) => (form.mode = v as Mode), [
          ['live', 'Live: everyone online now'],
          ['async', 'Take turns: play whenever you like'],
        ]),
      ),
      h(
        'div',
        { class: 'row' },
        h('label', { for: 'target' }, 'Play to'),
        select('target', form.target, (v) => (form.target = v), [
          ['2500', '2,500 points (shorter)'],
          ['5000', '5,000 points'],
          ['10000', '10,000 points (longer)'],
        ]),
      ),
      h('button', { class: 'primary', id: 'create', onclick: () => void createTable() }, 'Create table'),
    ),

    h(
      'section',
      { class: 'panel' },
      h('h2', {}, 'Join a table'),
      h('div', { class: 'row' }, h('label', { for: 'code' }, 'Table code'), codeInput),
      h(
        'button',
        {
          class: 'primary',
          id: 'join',
          onclick: () => {
            void joinOnline(form.joinCode, form.name.trim(), personal ?? undefined);
          },
        },
        'Join',
      ),
    ),

    (() => {
      const saved = loadSavedLocal();
      if (!saved) return null;
      const g = saved.game!;
      return h(
        'section',
        { class: 'panel' },
        h('h2', {}, saved.settings.bots?.length ? 'Unfinished game against the computer' : 'Unfinished pass & play game'),
        h('p', { class: 'muted' }, `${saved.settings.players} players · hand ${g.handNumber} · score ${g.scores[0]} to ${g.scores[1]}`),
        h(
          'div',
          { class: 'row buttons' },
          h('button', { id: 'resume', class: 'primary', onclick: () => startLocal(saved.settings.players, true) }, 'Resume'),
          h('button', { id: 'discard-save', onclick: () => (clearSavedLocal(), render()) }, 'Discard it'),
        ),
      );
    })(),
    h(
      'section',
      { class: 'panel' },
      h('h2', {}, 'Pass & play on this device'),
      h('p', { class: 'muted' }, 'Everyone shares one screen and hides their cards between turns. No internet needed.'),
      h(
        'div',
        { class: 'row buttons' },
        h('button', { id: 'local2', onclick: () => startLocal(2) }, '2 players'),
        h('button', { id: 'local4', onclick: () => startLocal(4) }, '4 players'),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', {}, 'Play against the computer'),
      h('p', { class: 'muted' }, 'On your own: against one computer player, or with a computer partner against two. No internet needed.'),
      h(
        'label',
        {},
        'Computer players: ',
        select('bot-level', form.botLevel, (v) => (form.botLevel = v as 'easy' | 'normal'), [
          ['normal', 'Normal'],
          ['easy', 'Easy'],
        ]),
      ),
      h(
        'div',
        { class: 'row buttons' },
        h('button', { id: 'vs2', onclick: () => startLocal(2, false, true) }, 'You against the computer'),
        h('button', { id: 'vs4', onclick: () => startLocal(4, false, true) }, 'You and a partner against two'),
      ),
    ),

    h(
      'details',
      { class: 'panel rules' },
      h('summary', {}, 'The rules used here'),
      h(
        'ul',
        {},
        h('li', {}, 'Two packs plus four jokers (108 cards). Jokers and 2s are wild. Red 3s score a bonus and are replaced at once.'),
        h('li', {}, '4 players: partners sit opposite (seats 1 & 3 against 2 & 4). 11 cards each, draw one, discard one, one canasta to go out.'),
        h('li', {}, '2 players: each for themselves. 15 cards each, draw one, discard one, one canasta to go out.'),
        h('li', {}, 'Your first meld must reach a minimum (50 points at the start, more as your score grows).'),
        h('li', {}, 'You may only take the discard pile once your side already has a meld on the table, and it is always optional.'),
        h('li', {}, 'A pile with a wild card in it is frozen. You can still take it if the top card matches a meld you already have (no wild cards used); otherwise you need two natural cards of that rank in your hand. Black 3s block the pile for one turn.'),
        h('li', {}, 'In live games you can only see the top card of the pile, as at a real table. Take-turns and pass & play games let you look through it, because it is hard to remember over days or on a shared screen.'),
        h('li', {}, 'A canasta is seven or more cards: natural 500, mixed 300. First side to the target score wins.'),
      ),
    ),
  );
}

function renderError(message: string): HTMLElement {
  return h(
    'div',
    { class: 'home' },
    h('h1', {}, 'Canasta'),
    h('p', { class: 'form-error', role: 'alert' }, message),
    h('button', { class: 'primary', onclick: leave }, 'Back'),
  );
}

function copyButton(label: string, text: string): HTMLElement {
  return h(
    'button',
    {
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          showToast('Copied.');
        } catch {
          showToast(text);
        }
      },
    },
    label,
  );
}

function renderLobby(): HTMLElement {
  const info = room!;
  const players = info.settings.players;
  const base = `${location.origin}/?room=${info.code}`;
  const token = safeGet(`canasta.token.${info.code}`);
  const isHost = you === 0;
  const filled = info.seats.filter(Boolean).length;

  const seatRow = (seat: number) => {
    const s = info.seats[seat];
    const team = players === 4 ? (seat % 2 === 0 ? 'Team 1' : 'Team 2') : '';
    return h(
      'li',
      { class: `${s ? 'seat taken' : 'seat'}${voice?.speaking.has(seat) ? ' speaking' : ''}`, 'data-seat': String(seat) },
      h('span', { class: 'seat-name' }, s ? s.name : 'Waiting for a player…'),
      voiceTag(seat),
      seat === you ? h('span', { class: 'tag' }, 'you') : null,
      seat === 0 ? h('span', { class: 'tag' }, 'host') : null,
      team ? h('span', { class: 'tag team' }, team) : null,
      s && !s.connected ? h('span', { class: 'tag off' }, 'offline') : null,
    );
  };

  return h(
    'div',
    { class: 'home' },
    h('h1', {}, 'Canasta'),
    h(
      'section',
      { class: 'panel lobby' },
      h('p', { class: 'muted' }, 'Table code'),
      h('div', { class: 'big-code', id: 'table-code' }, info.code),
      voice ? h('div', { class: 'row buttons voice-row' }, micButton()) : null,
      h(
        'p',
        { class: 'muted' },
        `${players} players · ${info.settings.mode === 'live' ? 'Live' : 'Take turns'} · play to ${info.settings.targetScore.toLocaleString('en')}`,
      ),
      h('ul', { class: 'seats' }, ...Array.from({ length: players }, (_, i) => seatRow(i))),
      players === 4 ? h('p', { class: 'muted' }, 'Players 1 & 3 are partners, as are 2 & 4. Seats fill in the order people join.') : null,
      info.settings.mode === 'async'
        ? h(
            'p',
            { class: 'muted' },
            'Take-turns game: the table stays open for 90 days. Come back any time with your personal link (below) and play when it is your turn. Phone or email alerts are not built yet.',
          )
        : null,
      h(
        'div',
        { class: 'row buttons' },
        copyButton('Copy invite link', base),
        token ? copyButton('Copy my personal link', `${base}&t=${token}`) : null,
      ),
      isHost
        ? h(
            'button',
            { class: 'primary', id: 'start', disabled: filled < players, onclick: () => send({ t: 'start' }) },
            filled < players ? `Waiting for ${players - filled} more…` : 'Start game',
          )
        : h('p', { class: 'muted' }, 'Waiting for the host to start the game…'),
    ),
    h('button', { onclick: leave }, 'Leave'),
  );
}

// ------------------------------------------------------------------ game screen

function meldEl(m: Meld, clickable: boolean): HTMLElement {
  const sorted = [...m.cardIds].sort((a, b) => Number(isWild(ALL_CARDS[a]!)) - Number(isWild(ALL_CARDS[b]!)));
  const canasta = isCanasta(m);
  const badge = canasta ? (isNaturalCanasta(m) ? 'Natural canasta' : 'Mixed canasta') : null;
  const classes = ['meld'];
  if (canasta) classes.push(isNaturalCanasta(m) ? 'canasta-natural' : 'canasta-mixed');
  if (clickable) classes.push('clickable');
  if (clickable && target === m.rank) classes.push('target');
  return h(
    'div',
    {
      class: classes.join(' '),
      role: clickable ? 'button' : undefined,
      'aria-pressed': clickable ? String(target === m.rank) : undefined,
      tabindex: clickable ? '0' : undefined,
      title: clickable ? 'Tap, then tap cards in your hand to add them to this meld' : undefined,
      onclick: clickable ? () => tapMeld(m.rank) : undefined,
      'data-rank': m.rank,
    },
    h('div', { class: 'meld-title' }, `${rankText(m.rank)} ×${m.cardIds.length}`, badge ? h('span', { class: 'badge' }, badge) : null),
    h('div', { class: 'meld-cards' }, ...sorted.map((id) => cardEl(id, { small: true }))),
  );
}

function sidePanel(side: number, canAdd: boolean): HTMLElement {
  const v = view!;
  const st = v.sides[side as 0 | 1];
  return h(
    'section',
    { class: 'side', 'data-side': String(side) },
    h(
      'header',
      {},
      h('strong', {}, sideLabel(side)),
      v.config.players === 4 ? h('span', { class: 'muted small' }, sideNames(side)) : null,
      h('span', { class: 'score' }, v.scores[side as 0 | 1].toLocaleString('en')),
    ),
    st.redThrees.length ? h('div', { class: 'red-threes' }, ...st.redThrees.map((id) => cardEl(id, { small: true }))) : null,
    h(
      'div',
      { class: 'melds' },
      ...(st.melds.length
        ? st.melds.map((m) => meldEl(m, canAdd && m.rank !== '3'))
        : [h('p', { class: 'muted small' }, 'No melds yet')]),
    ),
  );
}

function hintText(): string {
  const v = view!;
  const myTurn = v.turn.player === you;
  if (v.status !== 'playing') return '';
  if (!myTurn) {
    const who = seatName(v.turn.player);
    return v.turn.phase === 'draw' ? `${who} is about to draw…` : `${who} is playing…`;
  }
  const mySide = sideOf(v.config, you);
  const hasMeld = v.sides[mySide as 0 | 1].melds.length > 0;
  if (v.turn.phase === 'draw') {
    const take = hasMeld ? ' or take the pile' : '';
    return `Your turn. Draw from the stock${take}.`;
  }
  if (target) return `Adding to ${rankText(target)}s: tap a card in your hand (same rank, a Joker or a 2). Tap the meld again to stop.`;
  if (!hasMeld) {
    const min = initialMeldMinimum(v.scores[mySide as 0 | 1]);
    const points = sumPoints([...stagedIds(), ...selected]);
    return `Your first meld needs ${min} points. Selected so far: ${points}. Then discard one card.`;
  }
  return 'Meld what you can, then select one card and discard it to end your turn. To add to a meld, tap it, then tap your cards.';
}

function renderActions(): HTMLElement {
  const v = view!;
  const myTurn = v.turn.player === you && v.status === 'playing';
  const draw = myTurn && v.turn.phase === 'draw';
  const play = myTurn && v.turn.phase === 'play';
  const mySide = sideOf(v.config, you);
  const hasMeld = v.sides[mySide as 0 | 1].melds.length > 0;
  const top = v.pile.length ? ALL_CARDS[v.pile[v.pile.length - 1]!]! : null;
  const canTake = draw && !!top && hasMeld && !isWild(top) && top.rank !== '3';

  const btn = (label: string, id: string, enabled: boolean, onclick: () => void, primary = false) =>
    h('button', { id, class: primary ? 'primary' : '', disabled: !enabled, onclick }, label);

  return h(
    'div',
    { class: 'actions' },
    btn(v.config.drawCount === 2 ? 'Draw 2' : 'Draw', 'draw', draw, () => send({ t: 'action', action: { type: 'drawStock' } }), draw),
    btn('Take pile', 'take', canTake, takePile),
    btn('Stage', 'stage', play && selected.size > 0, () => void stageSelection()),
    btn(staged.length ? `Meld (${staged.length})` : 'Meld', 'meld', play && (selected.size > 0 || staged.length > 0), layDown, play),
    btn('Discard', 'discard', play, discard, play),
    play && v.myHand.length === 1 && !v.sides[mySide as 0 | 1].melds.some(isCanasta) ? btn('Skip discard', 'skip', true, () => send({ t: 'action', action: { type: 'skipDiscard' } })) : null,
    btn('Clear', 'clear', selected.size > 0 || staged.length > 0 || target !== null, clearSelection),
  );
}

function renderGame(): HTMLElement {
  const v = view!;
  const info = room!;
  const mySide = sideOf(v.config, you);
  const theirSide = 1 - mySide;
  const myTurn = v.turn.player === you && v.status === 'playing';
  const hiddenInHand = stagedIds();
  const hand = sortHand(v.myHand.filter((id) => !hiddenInHand.has(id)));
  const topId = v.pile.length ? v.pile[v.pile.length - 1]! : null;

  const seatChip = (seat: number) => {
    const s = info.seats[seat];
    const turn = v.turn.player === seat && v.status === 'playing';
    const partner = v.config.players === 4 && seat !== you && sideOf(v.config, seat) === mySide;
    return h(
      'li',
      { class: `chip${turn ? ' turn' : ''}${seat === you ? ' me' : ''}${voice?.speaking.has(seat) ? ' speaking' : ''}`, 'data-seat': String(seat) },
      h('span', { class: `dot${s?.connected || isLocal ? ' on' : ''}`, title: s?.connected ? 'online' : 'offline' }),
      h('span', {}, seatName(seat)),
      voiceTag(seat),
      seat === you ? h('span', { class: 'tag' }, 'you') : null,
      partner ? h('span', { class: 'tag team' }, 'partner') : null,
      h('span', { class: 'muted small' }, `${v.handSizes[seat]} cards`),
    );
  };

  const frozenNote = v.pileFrozen ? h('span', { class: 'tag frozen' }, '❄ frozen') : null;
  // Live tables show only the top card, as at a real table (the server doesn't even send the rest).
  // Take-turns tables and pass & play may look through the pile: remembering it over days, or on
  // a shared screen, is hard.
  const canLookThrough = info.settings.mode === 'async';
  const pileCards = canLookThrough
    ? h(
        'details',
        { class: 'pile-all' },
        h('summary', {}, 'Look through the pile'),
        h('div', { class: 'pile-cards' }, ...v.pile.map((id) => cardEl(id, { small: true }))),
      )
    : null;

  const staging =
    staged.length > 0
      ? h(
          'div',
          { class: 'staged', id: 'staged' },
          h('strong', {}, 'Ready to meld:'),
          ...staged.map((p) =>
            h('div', { class: 'staged-meld' }, h('span', { class: 'muted small' }, `${rankText(p.rank)}: `), ...p.cardIds.map((id) => cardEl(id, { small: true }))),
          ),
        )
      : null;

  const hint = hintText();

  return h(
    'div',
    { class: 'game' },
    h(
      'header',
      { class: 'topbar' },
      h('span', { class: 'brand' }, 'Canasta'),
      isLocal ? h('span', { class: 'tag' }, vsComputer() ? 'vs computer' : 'pass & play') : h('span', { class: 'tag table-code', id: 'room-code', title: 'Give this code to anyone who needs to join or rejoin' }, `Table ${info.code}`),
      isLocal ? null : h('span', { class: 'tag' }, info.settings.mode === 'live' ? 'Live' : 'Take turns'),
      !isLocal && info.settings.mode === 'async' && info.lastMoveAt ? h('span', { class: 'muted small' }, `last move ${timeAgo(info.lastMoveAt)}`) : null,
      h('span', { class: 'spacer' }),
      status !== 'open' && !isLocal ? h('span', { class: 'tag off', role: 'status' }, status === 'connecting' ? 'connecting…' : 'reconnecting…') : null,
      micButton(),
      h('button', { class: 'small-btn', id: 'enter-3d', onclick: () => void enter3d() }, '3D table'),
      h('button', { class: 'small-btn', onclick: () => ((overlayOpen = true), render()) }, 'Scores'),
      h('button', { class: 'small-btn', onclick: leave }, 'Leave'),
    ),
    h('ul', { class: 'chips' }, ...Array.from({ length: v.config.players }, (_, i) => seatChip(i))),
    h(
      'main',
      { class: 'table' },
      sidePanel(theirSide, false),
      h(
        'section',
        { class: 'center' },
        cardBack(v.stockCount, 'Stock'),
        h(
          'div',
          { class: 'pile-slot', id: 'pile' },
          topId !== null ? cardEl(topId) : h('span', { class: 'card empty' }),
          h('span', { class: 'pile-count' }, `Pile: ${v.pile.length}`, frozenNote),
        ),
        pileCards,
      ),
      sidePanel(mySide, myTurn && v.turn.phase === 'play'),
    ),
    // The "dock" holds everything you touch while playing. On a phone it sticks to the bottom
    // of the screen so the table can scroll behind it.
    h(
      'div',
      { class: 'dock' },
      h('p', { class: `hint${myTurn ? ' mine' : ''}`, id: 'hint', 'aria-live': 'polite' }, hint),
      staging,
      h(
        'section',
        { class: 'hand', id: 'hand', 'aria-label': 'Your hand' },
        ...hand.map((id, i) =>
          cardEl(id, {
            selected: selected.has(id),
            fresh: fresh.has(id),
            groupStart: i > 0 && handGroup(id) !== handGroup(hand[i - 1]!),
            onClick: () => {
              if (target) return addToTarget(id);
              if (selected.has(id)) selected.delete(id);
              else selected.add(id);
              render();
            },
            title: `${cardLabel(id)} · ${cardPoints(ALL_CARDS[id]!)} points`,
          }),
        ),
      ),
      renderActions(),
    ),
  );
}

function renderOverlay(): HTMLElement | null {
  const v = view;
  if (!v || !overlayOpen) return null;
  const mySide = sideOf(v.config, v.you);
  const result = v.handResult;
  const over = v.status === 'gameOver';
  const order = [mySide, 1 - mySide] as const;

  const row = (label: string, pick: (i: 0 | 1) => number | string) =>
    h('tr', {}, h('th', {}, label), ...order.map((s) => h('td', {}, String(pick(s as 0 | 1)))));

  const body = result
    ? h(
        'table',
        { class: 'scores' },
        h('thead', {}, h('tr', {}, h('th', {}), ...order.map((s) => h('th', {}, sideLabel(s))))),
        h(
          'tbody',
          {},
          row('Red threes', (s) => result.sideScores[s].redThrees),
          row('Canasta bonuses', (s) => result.sideScores[s].canastaBonus),
          row('Cards melded', (s) => result.sideScores[s].meldPoints),
          row('Going out', (s) => result.sideScores[s].goOutBonus),
          row('Cards left in hand', (s) => -result.sideScores[s].handPenalty),
          row('This hand', (s) => result.sideScores[s].total),
          row('Game total', (s) => v.scores[s].toLocaleString('en')),
        ),
      )
    : h(
        'table',
        { class: 'scores' },
        h('tbody', {}, ...order.map((s) => h('tr', {}, h('th', {}, sideLabel(s)), h('td', {}, v.scores[s as 0 | 1].toLocaleString('en'))))),
      );

  const title = overlayTitle(v);
  return h(
    'div',
    { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Scores' },
    h(
      'div',
      { class: 'dialog' },
      h('h2', { id: 'overlay-title' }, title),
      body,
      h(
        'div',
        { class: 'row buttons' },
        v.status === 'handOver' ? h('button', { class: 'primary', id: 'next-hand', onclick: () => send({ t: 'nextHand' }) }, 'Deal the next hand') : null,
        over ? h('button', { class: 'primary', id: 'rematch', onclick: () => send({ t: 'rematch' }) }, 'Play again') : null,
        h('button', { id: 'close-overlay', onclick: () => ((overlayOpen = false), render()) }, v.status === 'playing' ? 'Close' : 'Look at the table'),
      ),
    ),
  );
}

function overlayTitle(v: PlayerView): string {
  const mySide = sideOf(v.config, v.you);
  const result = v.handResult;
  const over = v.status === 'gameOver';
  return over
    ? v.winner === mySide
      ? v.config.players === 2
        ? 'You win!'
        : 'Your side wins!'
      : `${sideNames(v.winner ?? 0)} win${v.config.players === 2 ? 's' : ''}`
    : result
      ? result.endedBy === 'wentOut'
        ? `${seatName(result.wentOutPlayer!)} went out${result.concealed ? ' (concealed)' : ''}`
        : 'The stock ran out'
      : 'Scores';
}

// ------------------------------------------------------------------ 3D table

async function enter3d(): Promise<void> {
  in3d = true;
  render();
  if (table3d) return;
  try {
    const mod = await import('./xr/table3d.js');
    if (!in3d) return;
    table3d = new mod.Table3D(host3d, tableActions);
    xr = await mod.xrSupport();
    render();
  } catch (e) {
    in3d = false;
    console.error(e);
    // A new version of the app arrived while this page was open: reload into it (the game comes back).
    if (updateReady) return applyUpdate();
    showToast('The 3D table could not start on this device.');
  }
}

function exit3d(rerender = true): void {
  table3d?.dispose();
  table3d = null;
  in3d = false;
  if (rerender) render();
}

function render3dControls(): HTMLElement {
  return h(
    'div',
    { class: 'three-controls' },
    isLocal || !room ? null : h('span', { class: 'tag table-code', id: 'room-code-3d' }, `Table ${room.code}`),
    view ? h('p', { class: `three-hint${view.turn.player === you ? ' mine' : ''}`, id: 'hint', 'aria-live': 'polite' }, hintText()) : null,
    micButton(),
    xr.vr ? h('button', { class: 'primary', id: 'enter-vr', onclick: () => void table3d?.enterXR('immersive-vr').catch(() => showToast('Could not start the headset view.')) }, 'Enter VR') : null,
    h('button', { id: 'exit-3d', onclick: () => exit3d() }, '2D view'),
  );
}

const tableActions: TableActions = {
  tapCard(id) {
    if (!view || view.turn.player !== you || view.turn.phase !== 'play' || view.status !== 'playing') {
      // Picking cards is fine at any time (plan ahead); only moves wait for your turn.
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return render();
    }
    if (target) return addToTarget(id);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    render();
  },
  tapMeld: (rank) => tapMeld(rank),
  tapStock() {
    if (!view || view.status !== 'playing') return;
    if (view.turn.player !== you) return showToast(`It's ${seatName(view.turn.player)}'s turn.`);
    if (view.turn.phase !== 'draw') return showToast('You have already drawn this turn.');
    send({ t: 'action', action: { type: 'drawStock' } });
  },
  tapPile() {
    if (!view || view.status !== 'playing') return;
    if (view.turn.player !== you) return showToast(`It's ${seatName(view.turn.player)}'s turn.`);
    // The same pile means "take it" before you draw and "discard onto it" after.
    if (view.turn.phase === 'draw') return takePile();
    discard();
  },
  tapCloth() {
    if (!view || view.turn.player !== you || view.turn.phase !== 'play') return;
    if (selected.size > 0) void stageSelection();
    else if (target) {
      target = null;
      render();
    }
  },
  layDown: () => layDown(),
  clear: () => clearSelection(),
  skipDiscard: () => send({ t: 'action', action: { type: 'skipDiscard' } }),
  reveal() {
    covered = false;
    render();
  },
  nextHand: () => send({ t: 'nextHand' }),
  rematch: () => send({ t: 'rematch' }),
  closeOverlay() {
    overlayOpen = false;
    render();
  },
  exit: () => exit3d(),
  toggleMic: () => tapMic(),
};

function tableModel(): TableModel {
  const v = view!;
  const info = room!;
  const mySide = sideOf(v.config, you);
  const myPlay = v.status === 'playing' && v.turn.player === you && v.turn.phase === 'play';
  const hidden = stagedIds();
  const result = v.handResult;
  const order = [mySide, 1 - mySide] as const;
  let overlay: TableModel['overlay'] = null;
  if (overlayOpen && v.status !== 'playing') {
    overlay = {
      title: overlayTitle(v),
      lines: order.map((s) => `${sideLabel(s)}: ${result ? `this hand ${result.sideScores[s as 0 | 1].total}, ` : ''}total ${v.scores[s as 0 | 1].toLocaleString('en')}`),
      button: v.status === 'handOver' ? 'nextHand' : v.status === 'gameOver' ? 'rematch' : null,
    };
  }
  return {
    view: v,
    seatNames: info.seats.map((_, i) => seatName(i)),
    seatOnline: info.seats.map((s) => isLocal || !!s?.connected),
    seatFigures: info.seats.map((s) => s?.figure),
    hand: sortHand(v.myHand.filter((id) => !hidden.has(id))),
    selected,
    fresh,
    staged,
    target,
    canAddToMelds: myPlay,
    canSkipDiscard: myPlay && v.myHand.length === 1 && !v.sides[mySide as 0 | 1].melds.some(isCanasta),
    canLookThrough: info.settings.mode === 'async',
    scoreLine: (isLocal ? '' : `Table ${info.code}   ·   `) + order.map((s) => `${sideLabel(s)} ${v.scores[s as 0 | 1].toLocaleString('en')}`).join('   ·   '),
    hint: hintText(),
    toast: toastText,
    connection: status !== 'open' && !isLocal ? (status === 'connecting' ? 'Connecting…' : 'Reconnecting…') : null,
    coveredFor: isLocal && covered && v.status === 'playing' ? seatName(you) : null,
    overlay,
    mic: !voice ? null : voice.needsTap ? 'Tap to hear the others' : voice.state === 'on' ? 'Mute my mic' : voice.state === 'muted' ? 'Unmute my mic' : voice.state === 'starting' ? (voice.stuck ? 'Tap to turn on voice' : 'Starting voice…') : voice.state === 'blocked' ? 'Microphone off' : 'Join voice chat',
  };
}

function renderCover(): HTMLElement {
  const name = seatName(you);
  return h(
    'div',
    { class: 'cover' },
    h('h1', {}, 'Canasta'),
    h('p', { class: 'cover-text' }, `Pass the device to ${name}.`),
    h('button', { class: 'primary', id: 'ready', onclick: () => ((covered = false), render()) }, `I'm ${name}. Show my cards`),
  );
}

// ------------------------------------------------------------------ render

function render(): void {
  if (updateReady && !transport && !fatal) {
    applyUpdate();
    return;
  }
  const children: (HTMLElement | null)[] = [];
  if (fatal) children.push(renderError(fatal));
  else if (!transport) children.push(renderHome());
  else if (!room) children.push(h('div', { class: 'home' }, h('h1', {}, 'Canasta'), h('p', { class: 'muted', role: 'status' }, 'Connecting to the table…'), h('button', { onclick: leave }, 'Cancel')));
  else if (isLocal && covered && view?.status === 'playing' && !in3d) children.push(renderCover());
  else if (!view || room.phase === 'lobby') children.push(renderLobby());
  else if (in3d) {
    children.push(host3d, render3dControls());
    if (table3d) table3d.update(tableModel());
  } else {
    children.push(renderGame());
    children.push(renderOverlay());
  }
  if (toastText) children.push(h('div', { class: 'toast', role: 'status' }, toastText));
  if (updateReady && !in3d) children.push(h('p', { class: 'update-note', role: 'status' }, 'A new version of Canasta is ready. It starts when you go back to the start page.'));
  appEl.replaceChildren(...children.filter((c): c is HTMLElement => c !== null));
}

// Keep "last move … ago" fresh, without disturbing a selection in progress.
window.setInterval(() => {
  if (!isLocal && room?.settings.mode === 'async' && view && !fatal) render();
}, 60_000);

// ------------------------------------------------------------------ start

// Headset browsers (Meta Quest): bigger cards and buttons for pointing with a controller or a hand.
// ?xr=1 turns it on anywhere (to try it on a Mac), ?xr=0 turns it off; the choice is remembered.
(function headsetMode() {
  const q = new URLSearchParams(location.search).get('xr');
  if (q === '1' || q === '0') safeSet('canasta.xr', q);
  const saved = safeGet('canasta.xr');
  const quest = /OculusBrowser|Quest/i.test(navigator.userAgent);
  if (saved === '1' || (saved !== '0' && quest)) document.documentElement.classList.add('xr');
})();

(function init() {
  const params = new URLSearchParams(location.search);
  const code = (params.get('room') ?? '').toUpperCase();
  const personal = params.get('t');
  const stored = code ? safeGet(`canasta.token.${code}`) : null;
  if (code && (personal || stored)) void joinOnline(code, form.name.trim(), personal ?? undefined);
  else render();
})();

// Offline support: after one visit the app opens without a connection (pass & play needs none).
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  // Automatic updates. A new version downloads in the background and waits. On the start page the app
  // lets it take over and reloads straight away; during a game a note says it loads when you go back
  // to the start page. Until then the game keeps using its own version's files (never a mix of old and new).
  const hadVersion = !!navigator.serviceWorker.controller; // false on the very first visit: nothing to update
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applyingUpdate) return location.reload();
    // An older version of the app took over by itself: the files on this page may no longer match.
    if (hadVersion && !updateReady) {
      updateReady = true;
      render();
    }
  });
  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      const waitingNow = () => {
        if (!navigator.serviceWorker.controller || !reg.waiting || updateReady) return;
        waitingWorker = reg.waiting;
        updateReady = true;
        render();
      };
      waitingNow();
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        next?.addEventListener('statechange', () => next.state === 'installed' && waitingNow());
      });
      // Headsets and phones keep a tab open for days: look for a new version whenever the app comes back to the front.
      const check = () => void reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      window.setInterval(check, 30 * 60_000);
    })
    .catch(() => {
      // not available (private mode, plain http on a LAN address): the game still works online
    });
}
