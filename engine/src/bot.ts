// Computer players. A bot sees exactly what a human in its seat would see (a PlayerView:
// its own hand, the table, and only counts for the other hands and the stock), so it
// cannot cheat. Each call returns ONE action; call it again after the action has been
// applied until the turn passes. The bot keeps no memory between calls, so a saved
// game can be resumed with nothing extra stored.
//
// Every move the bot considers is first tried on a copy of the game (built from the
// view) with the real engine, so it only ever proposes moves the rules accept.

import { type Card, type MeldRank, cardById, cardPoints, isBlackThree, isWild } from './cards.js';
import { initialMeldMinimum, sideOf } from './config.js';
import { type Action, type GameState, IllegalMoveError, applyAction } from './engine.js';
import { type Meld, type MeldPlay, isCanasta } from './melds.js';
import type { PlayerView } from './view.js';

export type BotLevel = 'easy' | 'normal';

/** The bot takes the pile when it holds at least this many cards (or when taking it costs nothing). */
const PILE_WORTH_TAKING = 3;

// ---------------------------------------------------------------- trying moves safely

/**
 * A game state the engine accepts for the bot's own moves. Other hands and the stock are
 * unknown to the bot, so they are left empty: the moves tried here (taking the pile,
 * melding, discarding) never touch them.
 */
function stateFromView(v: PlayerView): GameState {
  const hands = v.handSizes.map(() => [] as number[]);
  hands[v.you] = [...v.myHand];
  return {
    config: v.config,
    handNumber: v.handNumber,
    dealer: v.dealer,
    stock: [],
    pile: v.pile.filter((id) => id >= 0), // a live table hides the cards under the top one
    pileFrozen: v.pileFrozen,
    hands,
    sides: structuredClone(v.sides),
    scores: [...v.scores],
    // Scores only change at the end of a hand, so during a hand they are the scores at its start.
    scoresAtHandStart: [...v.scores],
    turn: { ...v.turn },
    status: v.status,
    handResult: null,
    winner: null,
  };
}

function tryMove(base: GameState, player: number, action: Action): GameState | null {
  try {
    return applyAction(base, player, action);
  } catch (e) {
    if (e instanceof IllegalMoveError) return null;
    throw e;
  }
}

// ---------------------------------------------------------------- reading the hand

interface HandParts {
  naturals: Map<MeldRank, number[]>;
  wilds: number[]; // jokers first (worth more points), then 2s
  blackThrees: number[];
}

function splitHand(hand: readonly number[]): HandParts {
  const naturals = new Map<MeldRank, number[]>();
  const wilds: number[] = [];
  const blackThrees: number[] = [];
  for (const id of hand) {
    const c = cardById(id);
    if (isWild(c)) wilds.push(id);
    else if (isBlackThree(c)) blackThrees.push(id);
    else if (c.rank !== '3') {
      const r = c.rank as MeldRank;
      naturals.set(r, [...(naturals.get(r) ?? []), id]);
    }
  }
  wilds.sort((a, b) => cardPoints(cardById(b)) - cardPoints(cardById(a)));
  return { naturals, wilds, blackThrees };
}

const wildCount = (ids: readonly number[]): number => ids.filter((id) => isWild(cardById(id))).length;

/** Can one more wild card go into this meld (existing cards on the table plus cards being added)? */
function roomForWild(existing: Meld | undefined, adding: readonly number[]): boolean {
  if (existing && isCanasta(existing)) return false;
  const all = [...(existing?.cardIds ?? []), ...adding];
  const wilds = wildCount(all) + 1;
  return wilds <= 3 && all.length + 1 - wilds > wilds;
}

const toPlays = (m: Map<MeldRank, number[]>): MeldPlay[] =>
  [...m].filter(([, ids]) => ids.length > 0).map(([rank, cardIds]) => ({ rank, cardIds }));

// ---------------------------------------------------------------- the decision

/** The bot's next action. Only call it when it is this seat's turn and the hand is being played. */
export function botAction(view: PlayerView, level: BotLevel = 'normal', rand: () => number = Math.random): Action {
  if (view.status !== 'playing' || view.turn.player !== view.you) {
    throw new Error('botAction called when it is not the bot’s turn');
  }
  const base = stateFromView(view);
  return view.turn.phase === 'draw' ? chooseDraw(view, base, level, rand) : choosePlay(view, base, level, rand);
}

// ---- draw phase

function chooseDraw(v: PlayerView, base: GameState, level: BotLevel, rand: () => number): Action {
  const pile = v.pile;
  const topId = pile[pile.length - 1];
  const draw: Action = { type: 'drawStock' };
  if (topId === undefined || topId < 0) return draw;
  const top = cardById(topId);
  if (isWild(top) || top.rank === '3') return draw;
  if (level === 'easy' && rand() < 0.4) return draw;

  const rank = top.rank as MeldRank;
  const { naturals, wilds } = splitHand(v.myHand);
  const mine = naturals.get(rank) ?? [];

  // Cheapest way first: no cards from the hand (top card joins an unfinished meld we have),
  // then a natural pair, then (unfrozen only, big piles only) one natural and one wild.
  const options: { action: Action; free: boolean }[] = [
    { action: { type: 'takePile', melds: [] }, free: true },
  ];
  if (mine.length >= 2) options.push({ action: { type: 'takePile', melds: [{ rank, cardIds: mine.slice(0, 2) }] }, free: false });
  if (!v.pileFrozen && mine.length >= 1 && wilds.length > 0 && pile.length >= PILE_WORTH_TAKING + 1) {
    options.push({ action: { type: 'takePile', melds: [{ rank, cardIds: [mine[0]!, wilds[wilds.length - 1]!] }] }, free: false });
  }
  for (const o of options) {
    if (!o.free && pile.length < PILE_WORTH_TAKING) continue;
    if (tryMove(base, v.you, o.action)) return o.action;
  }
  return draw;
}

// ---- play phase

function choosePlay(v: PlayerView, base: GameState, level: BotLevel, rand: () => number): Action {
  const me = v.you;
  const side = v.sides[sideOf(v.config, me)]!;
  const hasCanasta = side.melds.some(isCanasta);

  // 1. Go out if everything (but at most one card to discard) can be melded.
  const out = goingOutMeld(v);
  if (out) {
    const after = tryMove(base, me, out);
    if (after && (after.status !== 'playing' || after.hands[me]!.length <= 1)) {
      const sideAfter = after.sides[sideOf(v.config, me)]!;
      if (after.status !== 'playing' || sideAfter.melds.filter(isCanasta).length >= v.config.canastasToGoOut) return out;
    }
  }

  const { naturals, wilds } = splitHand(v.myHand);

  // 2. First meld of the hand.
  if (side.melds.length === 0) {
    const first = initialMeld(v, naturals, wilds);
    if (first && tryMove(base, me, first)) return first;
    return chooseDiscard(v, base, level, rand);
  }

  // 3. Extend our melds with matching natural cards.
  const extend = new Map<MeldRank, number[]>();
  for (const m of side.melds) {
    if (m.rank === '3') continue;
    const ids = naturals.get(m.rank as MeldRank);
    if (ids?.length) extend.set(m.rank as MeldRank, ids);
  }
  const ext = firstLegalSubset(base, me, toPlays(extend));
  if (ext) return ext;

  // 4. No canasta yet: finish a meld of 5 or 6 cards with wild cards.
  if (!hasCanasta && wilds.length > 0 && (level === 'normal' || rand() < 0.3)) {
    const near = side.melds
      .filter((m) => m.rank !== '3' && m.cardIds.length >= 5 && m.cardIds.length < 7)
      .sort((a, b) => b.cardIds.length - a.cardIds.length);
    for (const m of near) {
      const need = 7 - m.cardIds.length;
      const add: number[] = [];
      for (const w of wilds) {
        if (add.length >= need || !roomForWild(m, add)) break;
        add.push(w);
      }
      if (add.length === need) {
        const a: Action = { type: 'meld', melds: [{ rank: m.rank, cardIds: add }] };
        if (tryMove(base, me, a)) return a;
      }
    }
  }

  // 5. New melds from three or more natural cards of a rank. Pairs stay in hand to take the pile later.
  const fresh = new Map<MeldRank, number[]>();
  for (const [rank, ids] of naturals) {
    if (ids.length >= 3 && !side.melds.some((m) => m.rank === rank)) fresh.set(rank, ids);
  }
  const fr = firstLegalSubset(base, me, toPlays(fresh));
  if (fr) return fr;

  // 6. Discard.
  return chooseDiscard(v, base, level, rand);
}

/** Try all the plays at once, then each one alone (e.g. if melding everything would empty the hand illegally). */
function firstLegalSubset(base: GameState, me: number, plays: MeldPlay[]): Action | null {
  if (plays.length === 0) return null;
  const all: Action = { type: 'meld', melds: plays };
  if (tryMove(base, me, all)) return all;
  for (const p of plays) {
    const one: Action = { type: 'meld', melds: [p] };
    if (tryMove(base, me, one)) return one;
    // Keep one card back so the hand is not emptied without a canasta.
    if (p.cardIds.length > 1) {
      const fewer: Action = { type: 'meld', melds: [{ rank: p.rank, cardIds: p.cardIds.slice(0, -1) }] };
      if (tryMove(base, me, fewer)) return fewer;
    }
  }
  return null;
}

/**
 * The first meld must reach the minimum for the side's score in one move. Take every rank
 * with three or more naturals; if that is not enough, add pairs with a wild card, then
 * extra wild cards, using as few wild cards as possible.
 */
function initialMeld(v: PlayerView, naturals: Map<MeldRank, number[]>, wildsIn: number[]): Action | null {
  const min = initialMeldMinimum(v.scores[sideOf(v.config, v.you)]!);
  const plays = new Map<MeldRank, number[]>();
  for (const [rank, ids] of naturals) if (ids.length >= 3) plays.set(rank, [...ids]);
  const wilds = [...wildsIn];
  const points = (): number => [...plays.values()].flat().reduce((t, id) => t + cardPoints(cardById(id)), 0);

  if (points() < min) {
    const pairs = [...naturals]
      .filter(([, ids]) => ids.length === 2)
      .sort((a, b) => cardPoints(cardById(b[1][0]!)) - cardPoints(cardById(a[1][0]!)));
    for (const [rank, ids] of pairs) {
      if (points() >= min || wilds.length === 0) break;
      plays.set(rank, [...ids, wilds.shift()!]);
    }
  }
  while (points() < min && wilds.length > 0) {
    const spot = [...plays].find(([, ids]) => roomForWild(undefined, ids));
    if (!spot) break;
    spot[1].push(wilds.shift()!);
  }
  if (plays.size === 0 || points() < min) return null;
  // Melding the whole hand without a canasta is not allowed; the engine check in the caller catches it.
  return { type: 'meld', melds: toPlays(plays) };
}

/** A single meld action that lays down everything possible, for going out. */
function goingOutMeld(v: PlayerView): Action | null {
  const side = v.sides[sideOf(v.config, v.you)]!;
  const { naturals, wilds, blackThrees } = splitHand(v.myHand);
  const plays = new Map<MeldRank, number[]>();
  let left = 0;

  for (const [rank, ids] of naturals) {
    const existing = side.melds.find((m) => m.rank === rank);
    if (existing || ids.length >= 3) plays.set(rank, [...ids]);
    else if (ids.length === 2 && wilds.length > 0) plays.set(rank, [...ids, wilds.shift()!]);
    else left += ids.length;
  }
  // Spare wild cards go onto any meld with room, preferring the longest (closest to a canasta).
  const targets = [...plays.keys()].sort((a, b) => {
    const len = (r: MeldRank) => (side.melds.find((m) => m.rank === r)?.cardIds.length ?? 0) + plays.get(r)!.length;
    return len(b) - len(a);
  });
  for (const m of side.melds) if (m.rank !== '3' && !plays.has(m.rank as MeldRank)) targets.push(m.rank as MeldRank);
  while (wilds.length > 0) {
    const r = targets.find((t) => roomForWild(side.melds.find((m) => m.rank === t), plays.get(t) ?? []));
    if (!r) break;
    plays.set(r, [...(plays.get(r) ?? []), wilds.shift()!]);
  }
  left += wilds.length;

  const melds = toPlays(plays);
  if (blackThrees.length >= 3) melds.push({ rank: '3', cardIds: blackThrees.slice(0, 4) });
  left += blackThrees.length >= 3 ? Math.max(0, blackThrees.length - 4) : blackThrees.length;

  if (left > 1 || melds.length === 0) return null;
  return { type: 'meld', melds };
}

// ---- discard

function chooseDiscard(v: PlayerView, base: GameState, level: BotLevel, rand: () => number): Action {
  const me = v.you;
  const hand = v.myHand;
  const next = (me + 1) % v.config.players;
  const theirMelds = v.sides[sideOf(v.config, next)]!.melds;
  const pileSize = v.pile.length;

  const counts = new Map<string, number>();
  for (const id of hand) counts.set(cardById(id).rank, (counts.get(cardById(id).rank) ?? 0) + 1);
  // Cards of a rank already out in the open (pile and every meld): the more, the fewer left for a pair.
  const visible = new Map<string, number>();
  const see = (id: number) => {
    if (id < 0) return;
    const c = cardById(id);
    visible.set(c.rank, (visible.get(c.rank) ?? 0) + 1);
  };
  v.pile.forEach(see);
  for (const s of v.sides) for (const m of s.melds) m.cardIds.forEach(see);

  const score = (id: number): number => {
    const c: Card = cardById(id);
    if (isBlackThree(c)) return 0; // blocks the next player from taking the pile
    if (isWild(c)) return 10_000;
    let s = 100 + (counts.get(c.rank)! - 1) * 60; // break up pairs last
    const theirs = theirMelds.find((m) => m.rank === c.rank);
    if (theirs && !isCanasta(theirs)) s += 200 + pileSize * 15; // they could take the pile with it
    if (theirs && isCanasta(theirs)) s -= 20; // a finished canasta cannot be used to take the pile
    s -= (visible.get(c.rank) ?? 0) * 8;
    s -= cardPoints(c) / 5; // shed high cards a little sooner
    return s;
  };

  const order = [...hand].sort((a, b) => score(a) - score(b) || a - b);
  if (level === 'easy' && rand() < 0.33) {
    const plain = order.filter((id) => !isWild(cardById(id)));
    if (plain.length) order.unshift(plain[Math.floor(rand() * plain.length)]!);
  }
  for (const id of order) {
    const a: Action = { type: 'discard', cardId: id };
    if (tryMove(base, me, a)) return a;
  }
  return { type: 'skipDiscard' };
}

/** One line describing a bot's action, for the screen. */
export function describeBotAction(name: string, action: Action): string {
  switch (action.type) {
    case 'drawStock':
      return `${name} draws from the stock.`;
    case 'takePile':
      return `${name} takes the discard pile.`;
    case 'meld': {
      const n = action.melds.reduce((t, m) => t + m.cardIds.length, 0);
      return `${name} melds ${n} card${n === 1 ? '' : 's'}.`;
    }
    case 'discard': {
      const c = cardById(action.cardId);
      const label = c.rank === 'JOKER' ? 'a Joker' : `a ${c.rank}`;
      return `${name} discards ${label}.`;
    }
    case 'skipDiscard':
      return `${name} keeps their last card.`;
  }
}
