import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_CARDS } from '../../engine/src/index.js';
import { handGroup, sortHand } from '../cardview.js';

const find = (rank: string, suit?: string) => ALL_CARDS.find((c) => c.rank === rank && (suit === undefined || c.suit === suit))!.id;
const label = (id: number) => `${ALL_CARDS[id]!.rank}${ALL_CARDS[id]!.suit ?? ''}`;

test('the hand runs high to low, then black threes, then wild cards', () => {
  const hand = [find('3', 'C'), find('4', 'H'), find('2', 'S'), find('3', 'S'), find('A', 'D'), find('JOKER'), find('4', 'S'), find('K', 'C')];
  assert.deepEqual(sortHand(hand).map(label), ['AD', 'KC', '4S', '4H', '3S', '3C', 'JOKER', '2S']);
});

test('black threes never sit among the fours', () => {
  const fours = ALL_CARDS.filter((c) => c.rank === '4').map((c) => c.id);
  const threes = ALL_CARDS.filter((c) => c.rank === '3' && (c.suit === 'S' || c.suit === 'C')).map((c) => c.id);
  const sorted = sortHand([...threes, ...fours]);
  assert.ok(sorted.slice(0, fours.length).every((id) => ALL_CARDS[id]!.rank === '4'));
  assert.deepEqual([...new Set(sorted.map(handGroup))], [0, 1]);
});
