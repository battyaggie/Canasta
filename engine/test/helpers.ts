import {
  ALL_CARDS,
  type Action,
  type GameState,
  type Meld,
  type Rank,
  type Suit,
  applyAction,
  cardId,
  defaultConfig,
  isWild,
  newGame,
} from '../src/index.js';

/** Id of a specific card, e.g. c('7', 'H') or c('7', 'H', 1) for the second deck. */
export const c = (rank: Rank, suit: Suit | null = 'S', deck: 0 | 1 = 0, jokerIndex: 0 | 1 = 0): number =>
  cardId(rank, rank === 'JOKER' ? null : suit, deck, jokerIndex);

function meldFromIds(group: number[]): Meld {
  const natural = group.map((id) => ALL_CARDS[id]!).find((card) => !isWild(card));
  if (!natural) throw new Error('scenario: a meld needs at least one natural card');
  return { rank: natural.rank as Meld['rank'], cardIds: [...group] };
}

/**
 * A scenario builder. Starts from a real deal, then overwrites hands, pile and melds
 * with exactly the cards the test wants. Cards not mentioned go to the stock, so all
 * 108 cards are always accounted for.
 */
export function scenario(opts: {
  players?: 2 | 4;
  hands: number[][];
  pile?: number[];
  pileFrozen?: boolean;
  melds?: [number[][], number[][]]; // [side0 melds, side1 melds], each meld a list of card ids
  redThrees?: [number[], number[]];
  scores?: [number, number];
  /** Cards to put on top of the stock; the LAST id in this list is drawn first. */
  stockEnd?: number[];
  /** Leave the stock empty (everything unused is discarded from play, so conservation does not hold). */
  emptyStock?: boolean;
  player?: number;
  phase?: 'draw' | 'play';
  configOverrides?: Parameters<typeof defaultConfig>[1];
}): GameState {
  const players = opts.players ?? 2;
  const base = newGame(defaultConfig(players, opts.configOverrides), 1);
  const used = new Set<number>();
  const take = (ids: number[]): number[] => {
    for (const id of ids) {
      if (used.has(id)) throw new Error(`scenario: card ${id} used twice`);
      used.add(id);
    }
    return ids;
  };

  const hands = Array.from({ length: players }, (_, i) => take([...(opts.hands[i] ?? [])]));
  const pile = take([...(opts.pile ?? [c('Q', 'C', 1)])]);
  const meldList = (groups: number[][] | undefined): Meld[] =>
    (groups ?? []).map((g) => {
      take(g);
      return meldFromIds(g);
    });
  const sides: GameState['sides'] = [
    { melds: meldList(opts.melds?.[0]), redThrees: take([...(opts.redThrees?.[0] ?? [])]) },
    { melds: meldList(opts.melds?.[1]), redThrees: take([...(opts.redThrees?.[1] ?? [])]) },
  ];

  let stock: number[] = [];
  for (let id = 0; id < 108; id++) if (!used.has(id)) stock.push(id);
  if (opts.stockEnd) {
    const top = new Set(opts.stockEnd);
    for (const id of top) if (used.has(id)) throw new Error(`scenario: stockEnd card ${id} already used`);
    stock = [...stock.filter((id) => !top.has(id)), ...opts.stockEnd];
  }
  if (opts.emptyStock) stock = [];

  const player = opts.player ?? 0;
  return {
    ...base,
    hands,
    pile,
    pileFrozen: opts.pileFrozen ?? false,
    sides,
    stock,
    scores: opts.scores ?? [0, 0],
    scoresAtHandStart: opts.scores ?? [0, 0],
    turn: {
      player,
      phase: opts.phase ?? 'draw',
      tookPile: false,
      sideHadMeldsAtStart: sides[players === 2 ? player : player % 2]!.melds.length > 0,
    },
    status: 'playing',
    handResult: null,
    winner: null,
  };
}

export function act(state: GameState, player: number, action: Action): GameState {
  return applyAction(state, player, action);
}

/** All 108 cards must be somewhere, exactly once. */
export function checkConservation(s: GameState): void {
  const all: number[] = [
    ...s.stock,
    ...s.pile,
    ...s.hands.flat(),
    ...s.sides.flatMap((x) => [...x.redThrees, ...x.melds.flatMap((m) => m.cardIds)]),
  ];
  if (all.length !== 108 || new Set(all).size !== 108) {
    throw new Error(`Card conservation broken: ${all.length} cards, ${new Set(all).size} unique`);
  }
}
