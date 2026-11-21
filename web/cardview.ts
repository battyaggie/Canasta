import { ALL_CARDS, isWild } from '../engine/src/index.js';
import { h } from './dom.js';

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_NAME: Record<string, string> = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };
const RANK_NAME: Record<string, string> = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' };

export function cardLabel(id: number): string {
  const c = ALL_CARDS[id]!;
  if (c.rank === 'JOKER') return 'Joker';
  return `${RANK_NAME[c.rank] ?? c.rank} of ${SUIT_NAME[c.suit!]}`;
}

/** Order for showing a hand: high to low, then black threes, then wild cards on the right. */
function sortKey(id: number): number {
  const c = ALL_CARDS[id]!;
  const suit = c.suit ? 'SHDC'.indexOf(c.suit) : 0;
  let group: number;
  let value: number;
  if (c.rank === 'JOKER') [group, value] = [2, 0];
  else if (c.rank === '2') [group, value] = [2, 1];
  else if (c.rank === '3') [group, value] = [1, 0];
  else {
    const order = ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    [group, value] = [0, 100 - order.indexOf(c.rank)];
  }
  // value * 10 + suit stays below 2000 (fours are 1000-1003), so groups must be 10000 apart.
  return group * 10000 + value * 10 + suit;
}

/** 0 = ordinary cards, 1 = black threes, 2 = wild cards; the hand leaves a gap between groups. */
export const handGroup = (id: number): number => Math.floor(sortKey(id) / 10000);

export const sortHand = (ids: readonly number[]): number[] => [...ids].sort((a, b) => sortKey(a) - sortKey(b));

export interface CardOpts {
  small?: boolean;
  selected?: boolean;
  /** Just drawn or picked up this turn. */
  fresh?: boolean;
  /** Starts a new group in the hand (black threes, wild cards). */
  groupStart?: boolean;
  onClick?: () => void;
  title?: string;
}

export function cardEl(id: number, opts: CardOpts = {}): HTMLElement {
  const c = ALL_CARDS[id]!;
  const red = c.suit === 'H' || c.suit === 'D';
  const classes = ['card', red ? 'red' : 'black'];
  if (isWild(c)) classes.push('wild');
  if (opts.small) classes.push('small');
  if (opts.selected) classes.push('selected');
  if (opts.fresh) classes.push('fresh');
  if (opts.groupStart) classes.push('group-start');
  const face =
    c.rank === 'JOKER'
      ? [h('span', { class: 'rank' }, '★'), h('span', { class: 'suit joker' }, 'JOKER')]
      : [h('span', { class: 'rank' }, c.rank), h('span', { class: 'suit' }, SUIT_SYMBOL[c.suit!])];
  const tag = opts.onClick ? 'button' : 'span';
  return h(
    tag,
    {
      class: classes.join(' '),
      type: opts.onClick ? 'button' : undefined,
      'aria-label': cardLabel(id) + (opts.fresh ? ' (new)' : '') + (opts.selected ? ' (selected)' : ''),
      'aria-pressed': opts.onClick ? String(!!opts.selected) : undefined,
      title: opts.title,
      onclick: opts.onClick,
    },
    ...face,
  );
}

export function cardBack(count: number, label: string): HTMLElement {
  return h('div', { class: 'pile-slot' }, h('span', { class: 'card back', 'aria-hidden': 'true' }), h('span', { class: 'pile-count' }, `${label}: ${count}`));
}
