import {
  type AnyMeldRank,
  type MeldRank,
  cardById,
  cardPoints,
  isBlackThree,
  isRedThree,
  isWild,
  shuffledDeck,
  sumPoints,
} from './cards.js';
import {
  type RulesConfig,
  initialMeldMinimum,
  playersOfSide,
  sideOf,
} from './config.js';
import {
  IllegalMoveError,
  type Meld,
  type MeldPlay,
  combineMeld,
  isCanasta,
  isNaturalCanasta,
  makeBlackThreeMeld,
} from './melds.js';

export { IllegalMoveError };

// ---------------------------------------------------------------- types

export interface SideState {
  melds: Meld[];
  redThrees: number[];
}

export interface TurnState {
  player: number;
  phase: 'draw' | 'play';
  tookPile: boolean;
  /** Did this side already have melds when the turn began? (for concealed going out) */
  sideHadMeldsAtStart: boolean;
}

export interface SideScore {
  redThrees: number;
  canastaBonus: number;
  meldPoints: number;
  goOutBonus: number;
  handPenalty: number;
  total: number;
}

export interface HandResult {
  endedBy: 'wentOut' | 'stockExhausted';
  wentOutPlayer: number | null;
  concealed: boolean;
  sideScores: [SideScore, SideScore];
}

export interface GameState {
  config: RulesConfig;
  handNumber: number;
  dealer: number;
  /** Top of the stock is the END of the array. */
  stock: number[];
  /** Top of the discard pile is the END of the array. Public information. */
  pile: number[];
  pileFrozen: boolean;
  hands: number[][];
  sides: [SideState, SideState];
  /** Cumulative scores per side, before the current hand is added. */
  scores: [number, number];
  /** Score each side had when the current hand started (sets the initial-meld minimum). */
  scoresAtHandStart: [number, number];
  turn: TurnState;
  status: 'playing' | 'handOver' | 'gameOver';
  handResult: HandResult | null;
  winner: number | null; // side index
}

export type Action =
  | { type: 'drawStock' }
  | { type: 'takePile'; melds: MeldPlay[] }
  | { type: 'meld'; melds: MeldPlay[] }
  | { type: 'discard'; cardId: number }
  | { type: 'skipDiscard' };

// ---------------------------------------------------------------- helpers

const canastaCount = (side: SideState): number => side.melds.filter(isCanasta).length;

function removeFromHand(hand: number[], ids: number[]): number[] {
  if (new Set(ids).size !== ids.length) throw new IllegalMoveError('Duplicate card id in move');
  const set = new Set(hand);
  for (const id of ids) if (!set.has(id)) throw new IllegalMoveError(`Card ${id} is not in your hand`);
  const remove = new Set(ids);
  return hand.filter((id) => !remove.has(id));
}

function cloneState(s: GameState): GameState {
  return structuredClone(s);
}

function layRedThree(s: GameState, side: number, id: number): void {
  s.sides[side]!.redThrees.push(id);
}

// ---------------------------------------------------------------- dealing

function dealHand(
  config: RulesConfig,
  scores: [number, number],
  handNumber: number,
  dealer: number,
  seed: number,
): GameState {
  const deck = shuffledDeck(seed);
  const hands: number[][] = Array.from({ length: config.players }, () => []);
  for (let i = 0; i < config.handSize; i++) {
    for (let p = 0; p < config.players; p++) hands[p]!.push(deck.pop()!);
  }

  const s: GameState = {
    config,
    handNumber,
    dealer,
    stock: deck,
    pile: [],
    pileFrozen: false,
    hands,
    sides: [
      { melds: [], redThrees: [] },
      { melds: [], redThrees: [] },
    ],
    scores: [...scores],
    scoresAtHandStart: [...scores],
    turn: { player: (dealer + 1) % config.players, phase: 'draw', tookPile: false, sideHadMeldsAtStart: false },
    status: 'playing',
    handResult: null,
    winner: null,
  };

  // Red threes dealt into hands are laid down at once and replaced from the stock.
  for (let p = 0; p < config.players; p++) {
    const side = sideOf(config, p);
    let guard = 0;
    for (;;) {
      const idx = s.hands[p]!.findIndex((id) => isRedThree(cardById(id)));
      if (idx < 0) break;
      const [id] = s.hands[p]!.splice(idx, 1);
      layRedThree(s, side, id!);
      s.hands[p]!.push(s.stock.pop()!);
      if (++guard > 20) throw new Error('Deal loop');
    }
  }

  // Turn up the first discard. Wild cards and threes are buried and freeze the pile;
  // keep turning until a natural card (4..A) is on top.
  for (;;) {
    const id = s.stock.pop()!;
    s.pile.push(id);
    const c = cardById(id);
    if (!isWild(c) && c.rank !== '3') break;
    s.pileFrozen = true;
  }

  s.turn.sideHadMeldsAtStart = false;
  return s;
}

export function newGame(config: RulesConfig, seed: number = Math.floor(Math.random() * 2 ** 31)): GameState {
  return dealHand(config, [0, 0], 1, 0, seed);
}

export function startNextHand(state: GameState, seed: number = Math.floor(Math.random() * 2 ** 31)): GameState {
  if (state.status !== 'handOver') throw new IllegalMoveError('Hand is not over');
  const dealer = (state.dealer + 1) % state.config.players;
  return dealHand(state.config, state.scores, state.handNumber + 1, dealer, seed);
}

// ---------------------------------------------------------------- scoring

function scoreHand(s: GameState, wentOutPlayer: number | null, concealed: boolean): [SideScore, SideScore] {
  const { config } = s;
  const out: SideScore[] = [];
  for (let side = 0; side < 2; side++) {
    const st = s.sides[side]!;
    const hasMelded = st.melds.length > 0;
    const n = st.redThrees.length;
    let red = n === 4 ? config.allRedThreesBonus : n * config.redThreeBonus;
    if (!hasMelded) red = -red;

    let canastaBonus = 0;
    let meldPoints = 0;
    for (const m of st.melds) {
      if (isCanasta(m)) canastaBonus += isNaturalCanasta(m) ? config.naturalCanastaBonus : config.mixedCanastaBonus;
      meldPoints += sumPoints(m.cardIds);
    }

    let goOut = 0;
    if (wentOutPlayer !== null && sideOf(config, wentOutPlayer) === side) {
      goOut = concealed ? config.concealedGoOutBonus : config.goOutBonus;
    }

    let handPenalty = 0;
    for (const p of playersOfSide(config, side)) handPenalty += sumPoints(s.hands[p]!);

    out.push({
      redThrees: red,
      canastaBonus,
      meldPoints,
      goOutBonus: goOut,
      handPenalty,
      total: red + canastaBonus + meldPoints + goOut - handPenalty,
    });
  }
  return out as [SideScore, SideScore];
}

function endHand(
  s: GameState,
  endedBy: HandResult['endedBy'],
  wentOutPlayer: number | null,
  concealed: boolean,
): void {
  const sideScores = scoreHand(s, wentOutPlayer, concealed);
  s.scores = [s.scores[0] + sideScores[0].total, s.scores[1] + sideScores[1].total];
  s.handResult = { endedBy, wentOutPlayer, concealed, sideScores };
  s.status = 'handOver';
  const target = s.config.targetScore;
  const max = Math.max(s.scores[0], s.scores[1]);
  if (max >= target && s.scores[0] !== s.scores[1]) {
    s.status = 'gameOver';
    s.winner = s.scores[0] > s.scores[1] ? 0 : 1;
  }
}

// ---------------------------------------------------------------- turn flow

function advanceTurn(s: GameState): void {
  const next = (s.turn.player + 1) % s.config.players;
  s.turn = {
    player: next,
    phase: 'draw',
    tookPile: false,
    sideHadMeldsAtStart: s.sides[sideOf(s.config, next)]!.melds.length > 0,
  };
}

function assertTurn(s: GameState, player: number, phase: TurnState['phase']): void {
  if (s.status !== 'playing') throw new IllegalMoveError('The hand is over');
  if (s.turn.player !== player) throw new IllegalMoveError('Not your turn');
  if (s.turn.phase !== phase) throw new IllegalMoveError(`You must ${s.turn.phase === 'draw' ? 'draw first' : 'meld or discard'}`);
}

/** Apply plays to a copy of the side's melds. Returns updated melds. */
function applyPlays(side: SideState, plays: MeldPlay[]): Meld[] {
  const melds = side.melds.map((m) => ({ rank: m.rank, cardIds: [...m.cardIds] }));
  const seen = new Set<AnyMeldRank>();
  for (const play of plays) {
    if (play.rank === '3') throw new IllegalMoveError('Black threes can only be melded when going out');
    if (seen.has(play.rank)) throw new IllegalMoveError(`Two plays for rank ${play.rank}`);
    seen.add(play.rank);
    const idx = melds.findIndex((m) => m.rank === play.rank);
    const combined = combineMeld(idx >= 0 ? melds[idx] : undefined, play.rank as MeldRank, play.cardIds);
    if (idx >= 0) melds[idx] = combined;
    else melds.push(combined);
  }
  return melds;
}

// ---------------------------------------------------------------- actions

function doDrawStock(s: GameState): void {
  const player = s.turn.player;
  const side = sideOf(s.config, player);
  let drawn = 0;
  while (drawn < s.config.drawCount) {
    if (s.stock.length === 0) {
      // Stock exhausted: the hand ends.
      endHand(s, 'stockExhausted', null, false);
      return;
    }
    const id = s.stock.pop()!;
    if (isRedThree(cardById(id))) {
      layRedThree(s, side, id); // replaced by drawing again, without counting
      continue;
    }
    s.hands[player]!.push(id);
    drawn++;
  }
  s.turn.phase = 'play';
}

function doTakePile(s: GameState, plays: MeldPlay[]): void {
  const { config } = s;
  const player = s.turn.player;
  const sideIdx = sideOf(config, player);
  const side = s.sides[sideIdx]!;
  const hand = s.hands[player]!;

  if (s.pile.length === 0) throw new IllegalMoveError('The discard pile is empty');
  const topId = s.pile[s.pile.length - 1]!;
  const top = cardById(topId);
  if (isWild(top) || top.rank === '3') throw new IllegalMoveError('The top card cannot be taken (wild card or three)');
  const rank = top.rank as MeldRank;

  // The pile may only be taken once the side already has a meld on the table
  // (made earlier, from the hand). It can never be used to make the first meld.
  if (side.melds.length === 0) {
    throw new IllegalMoveError('You cannot take the pile until your side has a meld on the table');
  }
  const frozenForSide = s.pileFrozen;

  const allIds = plays.flatMap((p) => p.cardIds);
  removeFromHand(hand, allIds); // validates membership & duplicates

  const topPlay = plays.find((p) => p.rank === rank);
  const existing = side.melds.find((m) => m.rank === rank);
  if (existing && isCanasta(existing)) {
    throw new IllegalMoveError('The pile cannot be taken using a completed canasta');
  }
  if (frozenForSide) {
    const played = topPlay?.cardIds ?? [];
    const naturals = played.filter((id) => !isWild(cardById(id))).length;
    if (existing) {
      // House rule (Mark): a frozen pile can always be taken when the top card matches a meld the side
      // already has. Freezing only means wild cards may not be used to take it.
      if (naturals < played.length) throw new IllegalMoveError('The pile is frozen: wild cards cannot be used to take it');
    } else if (naturals < 2) {
      throw new IllegalMoveError('The pile is frozen: you need two natural cards of the top rank in your hand');
    }
  } else if (!existing && !topPlay) {
    throw new IllegalMoveError('Nothing to meld the top card with');
  }

  // Build the melds, with the top card joining its own rank's meld.
  const adjusted = plays.map((p) => (p.rank === rank ? { rank: p.rank, cardIds: [topId, ...p.cardIds] } : p));
  if (!topPlay) adjusted.push({ rank, cardIds: [topId] });
  const newMelds = applyPlays(side, adjusted);

  // Commit.
  let newHand = removeFromHand(hand, allIds);
  const rest = s.pile.slice(0, -1);
  for (const id of rest) {
    if (isRedThree(cardById(id))) layRedThree(s, sideIdx, id); // no replacement for pile red threes
    else newHand.push(id);
  }
  s.hands[player] = newHand;
  side.melds = newMelds;
  s.pile = [];
  s.pileFrozen = false;
  s.turn.tookPile = true;
  s.turn.phase = 'play';
}

function doMeld(s: GameState, plays: MeldPlay[]): void {
  const { config } = s;
  const player = s.turn.player;
  const sideIdx = sideOf(config, player);
  const side = s.sides[sideIdx]!;
  const hand = s.hands[player]!;
  if (plays.length === 0) throw new IllegalMoveError('Nothing to meld');

  const allIds = plays.flatMap((p) => p.cardIds);
  const remaining = removeFromHand(hand, allIds);

  const normal = plays.filter((p) => p.rank !== '3');
  const black = plays.filter((p) => p.rank === '3');
  if (black.length > 1) throw new IllegalMoveError('Only one black-threes meld allowed');

  const melds = applyPlays(side, normal);
  if (black.length === 1) melds.push(makeBlackThreeMeld(black[0]!.cardIds));

  const canastas = melds.filter(isCanasta).length;
  const canGoOut = canastas >= config.canastasToGoOut;
  if (black.length === 1 && !(remaining.length <= 1 && canGoOut)) {
    throw new IllegalMoveError('Black threes may only be melded on the turn you go out');
  }
  if (remaining.length === 0 && !canGoOut) {
    throw new IllegalMoveError(`You need ${config.canastasToGoOut} canasta(s) before you can go out`);
  }

  if (side.melds.length === 0) {
    const concealedWaiver = !s.turn.tookPile && remaining.length <= 1 && canGoOut;
    const points = sumPoints(normal.flatMap((p) => p.cardIds));
    const min = initialMeldMinimum(s.scoresAtHandStart[sideIdx]!);
    if (!concealedWaiver && points < min) {
      throw new IllegalMoveError(`Initial meld needs ${min} points, you have ${points}`);
    }
  }

  s.hands[player] = remaining;
  side.melds = melds;
  if (remaining.length === 0) {
    const concealed = !s.turn.sideHadMeldsAtStart && !s.turn.tookPile;
    endHand(s, 'wentOut', player, concealed);
  }
}

function doDiscard(s: GameState, cardId: number): void {
  const player = s.turn.player;
  const sideIdx = sideOf(s.config, player);
  const side = s.sides[sideIdx]!;
  const hand = s.hands[player]!;
  const remaining = removeFromHand(hand, [cardId]);

  const canGoOut = canastaCount(side) >= s.config.canastasToGoOut;
  if (remaining.length === 0 && !canGoOut) {
    const need = s.config.canastasToGoOut;
    throw new IllegalMoveError(
      `You cannot go out yet: your side needs ${need} canasta${need === 1 ? '' : 's'} (a meld of 7 or more cards) and has ${canastaCount(side)}.`,
    );
  }

  s.hands[player] = remaining;
  s.pile.push(cardId);
  if (isWild(cardById(cardId))) s.pileFrozen = true;

  if (remaining.length === 0) {
    const concealed = !s.turn.sideHadMeldsAtStart && !s.turn.tookPile;
    endHand(s, 'wentOut', player, concealed);
    return;
  }
  advanceTurn(s);
}

function doSkipDiscard(s: GameState): void {
  const player = s.turn.player;
  const side = s.sides[sideOf(s.config, player)]!;
  const hand = s.hands[player]!;
  if (hand.length !== 1 || canastaCount(side) >= s.config.canastasToGoOut) {
    throw new IllegalMoveError('Skipping the discard is only allowed with one card left and no canasta to go out');
  }
  advanceTurn(s);
}

/** Apply one action for `player`. Pure: returns a new state, throws IllegalMoveError if the move is illegal. */
export function applyAction(state: GameState, player: number, action: Action): GameState {
  const s = cloneState(state);
  switch (action.type) {
    case 'drawStock':
      assertTurn(s, player, 'draw');
      doDrawStock(s);
      return s;
    case 'takePile':
      assertTurn(s, player, 'draw');
      doTakePile(s, action.melds);
      return s;
    case 'meld':
      assertTurn(s, player, 'play');
      doMeld(s, action.melds);
      return s;
    case 'discard':
      assertTurn(s, player, 'play');
      doDiscard(s, action.cardId);
      return s;
    case 'skipDiscard':
      assertTurn(s, player, 'play');
      doSkipDiscard(s);
      return s;
    default: {
      const never: never = action;
      throw new IllegalMoveError(`Unknown action ${JSON.stringify(never)}`);
    }
  }
}

export { isBlackThree };
