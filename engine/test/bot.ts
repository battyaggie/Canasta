// A deliberately simple bot used by the simulations. It only needs an `apply`
// function, so it can drive either the bare engine or the server-side Room.
import {
  ALL_CARDS,
  type Action,
  type GameState,
  type MeldPlay,
  type MeldRank,
  applyAction,
  isWild,
  sideOf,
} from '../src/index.js';

type Apply = (state: GameState, player: number, action: Action) => GameState;

const isRejection = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'IllegalMoveError' || e.name === 'RoomError');

function tryApply(apply: Apply, state: GameState, player: number, action: Action): GameState | null {
  try {
    return apply(state, player, action);
  } catch (e) {
    if (isRejection(e)) return null;
    throw e;
  }
}

function groupNaturals(hand: number[]): Map<string, number[]> {
  const g = new Map<string, number[]>();
  for (const id of hand) {
    const card = ALL_CARDS[id]!;
    if (isWild(card) || card.rank === '3') continue;
    g.set(card.rank, [...(g.get(card.rank) ?? []), id]);
  }
  return g;
}

export function botTurn(start: GameState, rand: () => number, apply: Apply = applyAction): GameState {
  let s = start;
  const p = s.turn.player;
  const side = s.sides[sideOf(s.config, p)]!;

  // --- draw phase ---
  if (s.turn.phase === 'draw') {
    const top = s.pile.length ? ALL_CARDS[s.pile[s.pile.length - 1]!]! : null;
    let took: GameState | null = null;
    if (top && !isWild(top) && top.rank !== '3' && rand() < 0.7) {
      const mine = groupNaturals(s.hands[p]!).get(top.rank) ?? [];
      const rank = top.rank as MeldRank;
      const existing = side.melds.some((m) => m.rank === rank);
      if (mine.length >= 2) {
        took = tryApply(apply, s, p, { type: 'takePile', melds: [{ rank, cardIds: mine.slice(0, 2) }] });
      }
      if (!took && existing) took = tryApply(apply, s, p, { type: 'takePile', melds: [] });
    }
    s = took ?? apply(s, p, { type: 'drawStock' });
    if (s.status !== 'playing') return s;
  }

  // --- meld phase ---
  const groups = groupNaturals(s.hands[p]!);
  const sideNow = () => s.sides[sideOf(s.config, p)]!;

  // extend existing melds with single naturals
  for (const [rank, ids] of groups) {
    if (sideNow().melds.some((m) => m.rank === rank)) {
      const next = tryApply(apply, s, p, { type: 'meld', melds: [{ rank: rank as MeldRank, cardIds: ids }] });
      if (next) {
        s = next;
        if (s.status !== 'playing') return s;
      }
    }
  }
  // new melds from sets of 3+
  const fresh: MeldPlay[] = [];
  for (const [rank, ids] of groupNaturals(s.hands[p]!)) {
    if (ids.length >= 3 && !sideNow().melds.some((m) => m.rank === rank)) {
      fresh.push({ rank: rank as MeldRank, cardIds: ids });
    }
  }
  if (fresh.length) {
    const all = tryApply(apply, s, p, { type: 'meld', melds: fresh });
    if (all) s = all;
    else {
      for (const f of fresh) {
        const one = tryApply(apply, s, p, { type: 'meld', melds: [f] });
        if (one) s = one;
      }
    }
    if (s.status !== 'playing') return s;
  }

  // --- discard ---
  const hand = [...s.hands[p]!];
  // prefer non-wild cards, and cards with the fewest matches
  const counts = new Map<string, number>();
  for (const id of hand) counts.set(ALL_CARDS[id]!.rank, (counts.get(ALL_CARDS[id]!.rank) ?? 0) + 1);
  hand.sort((a, b) => {
    const ca = ALL_CARDS[a]!;
    const cb = ALL_CARDS[b]!;
    const wa = isWild(ca) ? 1 : 0;
    const wb = isWild(cb) ? 1 : 0;
    if (wa !== wb) return wa - wb;
    return (counts.get(ca.rank) ?? 0) - (counts.get(cb.rank) ?? 0);
  });
  for (const id of hand) {
    const next = tryApply(apply, s, p, { type: 'discard', cardId: id });
    if (next) return next;
  }
  const skipped = tryApply(apply, s, p, { type: 'skipDiscard' });
  if (skipped) return skipped;
  throw new Error(`Bot is stuck: player ${p}, hand ${JSON.stringify(hand)}, phase ${s.turn.phase}`);
}

