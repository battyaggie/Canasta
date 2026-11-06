import {
  type AnyMeldRank,
  type MeldRank,
  cardById,
  isWild,
} from './cards.js';

export class IllegalMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalMoveError';
  }
}

export interface Meld {
  rank: AnyMeldRank;
  cardIds: number[];
}

/** A request to lay down (or extend) the meld of one rank using these hand cards. */
export interface MeldPlay {
  rank: AnyMeldRank;
  cardIds: number[];
}

export const isCanasta = (m: Meld): boolean => m.rank !== '3' && m.cardIds.length >= 7;

export function countMeld(m: Pick<Meld, 'cardIds'>): { naturals: number; wilds: number } {
  let wilds = 0;
  for (const id of m.cardIds) if (isWild(cardById(id))) wilds++;
  return { naturals: m.cardIds.length - wilds, wilds };
}

export const isNaturalCanasta = (m: Meld): boolean => isCanasta(m) && countMeld(m).wilds === 0;

/**
 * Create a new meld or extend an existing one, enforcing the group rules:
 *  - a new meld needs at least 3 cards
 *  - every card is a natural of the rank, or wild
 *  - at most 3 wild cards, and naturals must outnumber wilds
 *  - no wild cards may be added to a completed canasta (7+ cards)
 */
export function combineMeld(existing: Meld | undefined, rank: MeldRank, addIds: number[]): Meld {
  if (addIds.length === 0 && !existing) throw new IllegalMoveError('Empty meld');
  const ids = [...(existing?.cardIds ?? []), ...addIds];
  if (new Set(ids).size !== ids.length) throw new IllegalMoveError('Duplicate card in meld');

  let naturals = 0;
  let wilds = 0;
  for (const id of ids) {
    const c = cardById(id);
    if (isWild(c)) wilds++;
    else if (c.rank === rank) naturals++;
    else throw new IllegalMoveError(`Card ${c.rank} does not belong in a meld of ${rank}`);
  }

  const addedWilds = addIds.filter((id) => isWild(cardById(id))).length;
  if (existing && isCanasta(existing) && addedWilds > 0) {
    throw new IllegalMoveError('Wild cards cannot be added to a completed canasta');
  }
  if (!existing && ids.length < 3) throw new IllegalMoveError('A new meld needs at least 3 cards');
  if (wilds > 3) throw new IllegalMoveError('A meld may contain at most 3 wild cards');
  if (naturals <= wilds) throw new IllegalMoveError('Natural cards must outnumber wild cards in a meld');
  return { rank, cardIds: ids };
}

/** Black threes: only when going out, 3 or 4 cards, never with wild cards. */
export function makeBlackThreeMeld(ids: number[]): Meld {
  if (new Set(ids).size !== ids.length) throw new IllegalMoveError('Duplicate card in meld');
  if (ids.length < 3 || ids.length > 4) throw new IllegalMoveError('Black threes meld needs 3 or 4 cards');
  for (const id of ids) {
    const c = cardById(id);
    if (!(c.rank === '3' && (c.suit === 'S' || c.suit === 'C'))) {
      throw new IllegalMoveError('Only black threes may be melded as threes');
    }
  }
  return { rank: '3', cardIds: ids };
}
