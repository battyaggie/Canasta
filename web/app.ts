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
import type { ClientMsg, Mode, RoomInfo, ServerMsg } from '../shared/protocol.js';
import { cardBack, cardEl, cardLabel, sortHand } from './cardview.js';
import { h } from './dom.js';
import { LocalTransport, clearSavedLocal, loadSavedLocal, type Status, type Transport, WsTransport } from './transport.js';

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

const selected = new Set<number>();
let staged: MeldPlay[] = [];
/** A meld on the table the player has tapped: cards tapped in the hand now go straight onto it. */
let target: MeldPlay['rank'] | null = null;

const form = {
  name: safeGet('canasta.name') ?? '',
  players: '2',
  mode: 'live' as Mode,
  target: '5000',
  joinCode: '',
  error: '',
};

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
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
    if (!isLocal) safeSet(`canasta.token.${roomCode}`, msg.token);
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
  you = msg.you;
  room = msg.room;
  view = msg.view;
  // Pass & play: hide the cards whenever the turn moves to someone else, and at the start of each hand.
  if (isLocal && view?.status === 'playing' && (previousSeat !== you || previousStatus !== 'playing')) covered = true;
  reconcileSelection();
  const key = view ? `${view.handNumber}:${view.status}` : '';
  if (key !== lastOverlayKey) {
    lastOverlayKey = key;
    overlayOpen = view?.status === 'handOver' || view?.status === 'gameOver';
  }
  render();
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

function openTransport(t: (events: { onMessage: typeof handleMessage; onStatus: (s: Status) => void }) => Transport): void {
  resetGameState();
  transport?.close();
  transport = t({
    onMessage: handleMessage,
    onStatus: (s) => {
      status = s;
      render();
    },
  });
}

async function joinOnline(code: string, name: string, tokenFromLink?: string): Promise<void> {
  code = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(code)) {
    form.error = 'Table codes have 4 letters or digits.';
    return render();
  }
  form.error = '';
  try {
    const res = await fetch(`/api/room/${code}`);
    if (res.status === 404) {
      form.error = `There is no table with the code ${code}.`;
      return render();
    }
  } catch {
    form.error = 'Could not reach the server.';
    return render();
  }
  isLocal = false;
  roomCode = code;
  if (tokenFromLink) safeSet(`canasta.token.${code}`, tokenFromLink);
  history.replaceState(null, '', `?room=${code}`);
  if (name) safeSet('canasta.name', name);
  openTransport(
    (events) =>
      new WsTransport(code, events, () => {
        const token = safeGet(`canasta.token.${code}`) ?? undefined;
        return { t: 'hello', token, name: name || safeGet('canasta.name') || undefined };
      }),
  );
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

function startLocal(players: 2 | 4, resume = false): void {
  const saved = resume ? loadSavedLocal() : null;
  isLocal = true;
  roomCode = 'LOCAL';
  openTransport((events) => new LocalTransport(saved?.settings.players ?? players, events, saved));
  render();
}

function leave(): void {
  transport?.close();
  transport = null;
  resetGameState();
  isLocal = false;
  roomCode = '';
  history.replaceState(null, '', location.pathname);
  render();
}

const send = (msg: ClientMsg): void => transport?.send(msg);

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

    h('section', { class: 'panel' }, h('h2', {}, 'Your name'), nameInput),

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
            if (!form.name.trim() && !safeGet(`canasta.token.${form.joinCode}`) && !personal) {
              form.error = 'Please enter your name first.';
              return render();
            }
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
        h('h2', {}, 'Unfinished pass & play game'),
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
      { class: s ? 'seat taken' : 'seat' },
      h('span', { class: 'seat-name' }, s ? s.name : 'Waiting for a player…'),
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
            'Take-turns game: the table stays open for 30 days. Come back any time with your personal link (below) and play when it is your turn. Phone or email alerts are not built yet.',
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
      { class: `chip${turn ? ' turn' : ''}${seat === you ? ' me' : ''}`, 'data-seat': String(seat) },
      h('span', { class: `dot${s?.connected || isLocal ? ' on' : ''}`, title: s?.connected ? 'online' : 'offline' }),
      h('span', {}, seatName(seat)),
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
      isLocal ? h('span', { class: 'tag' }, 'pass & play') : h('span', { class: 'tag', id: 'room-code' }, info.code),
      isLocal ? null : h('span', { class: 'tag' }, info.settings.mode === 'live' ? 'Live' : 'Take turns'),
      !isLocal && info.settings.mode === 'async' && info.lastMoveAt ? h('span', { class: 'muted small' }, `last move ${timeAgo(info.lastMoveAt)}`) : null,
      h('span', { class: 'spacer' }),
      status !== 'open' && !isLocal ? h('span', { class: 'tag off', role: 'status' }, status === 'connecting' ? 'connecting…' : 'reconnecting…') : null,
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
        ...hand.map((id) =>
          cardEl(id, {
            selected: selected.has(id),
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

  const title = over
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
  const children: (HTMLElement | null)[] = [];
  if (fatal) children.push(renderError(fatal));
  else if (!transport) children.push(renderHome());
  else if (!room) children.push(h('div', { class: 'home' }, h('h1', {}, 'Canasta'), h('p', { class: 'muted', role: 'status' }, 'Connecting to the table…'), h('button', { onclick: leave }, 'Cancel')));
  else if (isLocal && covered && view?.status === 'playing') children.push(renderCover());
  else if (!view || room.phase === 'lobby') children.push(renderLobby());
  else {
    children.push(renderGame());
    children.push(renderOverlay());
  }
  if (toastText) children.push(h('div', { class: 'toast', role: 'status' }, toastText));
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
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // not available (private mode, plain http on a LAN address): the game still works online
  });
}
