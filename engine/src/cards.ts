// Card model for Canasta: two 52-card decks plus four jokers = 108 cards.
// Every physical card has a unique numeric id (0..107) so the engine can
// tell identical-looking cards apart.

export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank =
  | 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K'
  | 'JOKER';

/** Ranks that can be melded as a normal group (not wild, not threes). */
export type MeldRank = Exclude<Rank, '2' | '3' | 'JOKER'>;
/** Black threes can only be melded when going out, under the pseudo-rank '3'. */
export type AnyMeldRank = MeldRank | '3';

export interface Card {
  id: number;
  rank: Rank;
  suit: Suit | null; // null for jokers
}

export const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
export const RANK_ORDER: Exclude<Rank, 'JOKER'>[] = [
  'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K',
];

const CARDS_PER_DECK = 54;

/** Id of a specific physical card. deck is 0 or 1. Jokers: suit null, deck picks which pair, `jokerIndex` 0/1. */
export function cardId(rank: Rank, suit: Suit | null, deck: 0 | 1 = 0, jokerIndex: 0 | 1 = 0): number {
  if (rank === 'JOKER') return deck * CARDS_PER_DECK + 52 + jokerIndex;
  if (suit === null) throw new Error('Non-joker card needs a suit');
  return deck * CARDS_PER_DECK + SUITS.indexOf(suit) * 13 + RANK_ORDER.indexOf(rank);
}

function buildDeck(): Card[] {
  const cards: Card[] = [];
  for (let deck = 0; deck < 2; deck++) {
    for (const suit of SUITS) {
      for (const rank of RANK_ORDER) {
        cards.push({ id: cardId(rank, suit, deck as 0 | 1), rank, suit });
      }
    }
    // Two jokers per deck, so four in all.
    cards.push({ id: cardId('JOKER', null, deck as 0 | 1, 0), rank: 'JOKER', suit: null });
    cards.push({ id: cardId('JOKER', null, deck as 0 | 1, 1), rank: 'JOKER', suit: null });
  }
  return cards.sort((a, b) => a.id - b.id);
}

export const ALL_CARDS: readonly Card[] = buildDeck();
export const DECK_SIZE = ALL_CARDS.length; // 108

export function cardById(id: number): Card {
  const c = ALL_CARDS[id];
  if (!c) throw new Error(`Unknown card id ${id}`);
  return c;
}

export const isWild = (c: Card): boolean => c.rank === '2' || c.rank === 'JOKER';
export const isRedThree = (c: Card): boolean => c.rank === '3' && (c.suit === 'H' || c.suit === 'D');
export const isBlackThree = (c: Card): boolean => c.rank === '3' && (c.suit === 'S' || c.suit === 'C');
/** A natural card that can start or extend a normal meld (4 .. A). */
export const isMeldableNatural = (c: Card): boolean => !isWild(c) && c.rank !== '3';

/** Point value of a card when melded or left in hand. Red threes are scored separately. */
export function cardPoints(c: Card): number {
  if (c.rank === 'JOKER') return 50;
  if (c.rank === 'A' || c.rank === '2') return 20;
  if (c.rank === '3') return isBlackThree(c) ? 5 : 0;
  if (['8', '9', '10', 'J', 'Q', 'K'].includes(c.rank)) return 10;
  return 5; // 4-7
}

export const sumPoints = (ids: readonly number[]): number =>
  ids.reduce((t, id) => t + cardPoints(cardById(id)), 0);

// ---- Deterministic shuffling (so games can be replayed from a seed) ----

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffledDeck(seed: number): number[] {
  const ids = ALL_CARDS.map((c) => c.id);
  const rand = mulberry32(seed);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids;
}
