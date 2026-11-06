import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CARDS,
  DECK_SIZE,
  IllegalMoveError,
  cardPoints,
  combineMeld,
  defaultConfig,
  initialMeldMinimum,
  isRedThree,
  newGame,
  viewFor,
} from '../src/index.js';
import { c, checkConservation } from './helpers.js';

describe('deck', () => {
  it('has 108 unique cards with 4 jokers and 8 red threes', () => {
    assert.equal(DECK_SIZE, 108);
    assert.equal(new Set(ALL_CARDS.map((x) => x.id)).size, 108);
    assert.equal(ALL_CARDS.filter((x) => x.rank === 'JOKER').length, 4);
    assert.equal(ALL_CARDS.filter(isRedThree).length, 4 );
    assert.equal(ALL_CARDS.filter((x) => x.rank === '3').length, 8);
  });

  it('values cards correctly', () => {
    assert.equal(cardPoints(ALL_CARDS[c('JOKER', null)]!), 50);
    assert.equal(cardPoints(ALL_CARDS[c('A', 'S')]!), 20);
    assert.equal(cardPoints(ALL_CARDS[c('2', 'S')]!), 20);
    assert.equal(cardPoints(ALL_CARDS[c('K', 'S')]!), 10);
    assert.equal(cardPoints(ALL_CARDS[c('8', 'S')]!), 10);
    assert.equal(cardPoints(ALL_CARDS[c('7', 'S')]!), 5);
    assert.equal(cardPoints(ALL_CARDS[c('4', 'S')]!), 5);
    assert.equal(cardPoints(ALL_CARDS[c('3', 'S')]!), 5);
  });
});

describe('configuration', () => {
  it('uses 11 cards / 1 draw / 1 canasta for four players', () => {
    const cfg = defaultConfig(4);
    assert.deepEqual([cfg.handSize, cfg.drawCount, cfg.canastasToGoOut], [11, 1, 1]);
  });
  it('uses 15 cards / 1 draw / 1 canasta for two players', () => {
    const cfg = defaultConfig(2);
    assert.deepEqual([cfg.handSize, cfg.drawCount, cfg.canastasToGoOut], [15, 1, 1]);
  });
  it('initial meld minimums follow the score bands', () => {
    assert.equal(initialMeldMinimum(-10), 15);
    assert.equal(initialMeldMinimum(0), 50);
    assert.equal(initialMeldMinimum(1495), 50);
    assert.equal(initialMeldMinimum(1500), 90);
    assert.equal(initialMeldMinimum(2995), 90);
    assert.equal(initialMeldMinimum(3000), 120);
    assert.equal(initialMeldMinimum(7000), 150);
  });
});

describe('dealing', () => {
  for (const players of [2, 4] as const) {
    it(`deals correctly for ${players} players and conserves all cards`, () => {
      for (let seed = 1; seed <= 25; seed++) {
        const s = newGame(defaultConfig(players), seed);
        checkConservation(s);
        for (const h of s.hands) {
          assert.equal(h.length, s.config.handSize);
          assert.ok(!h.some((id) => isRedThree(ALL_CARDS[id]!)), 'no red threes left in hands');
        }
        const top = ALL_CARDS[s.pile[s.pile.length - 1]!]!;
        assert.ok(top.rank !== '3' && top.rank !== '2' && top.rank !== 'JOKER', 'top upcard is a natural');
        assert.equal(s.turn.player, 1 % players);
      }
    });
  }

  it('is deterministic for a given seed', () => {
    const a = newGame(defaultConfig(4), 42);
    const b = newGame(defaultConfig(4), 42);
    assert.deepEqual(a.hands, b.hands);
  });
});

describe('meld validation', () => {
  it('accepts natural sets and sets with up to 3 wild cards', () => {
    combineMeld(undefined, '7', [c('7', 'S'), c('7', 'H'), c('7', 'D')]);
    combineMeld(undefined, '7', [c('7', 'S'), c('7', 'H'), c('2', 'S')]);
    combineMeld(undefined, '7', [c('7', 'S'), c('7', 'H'), c('7', 'D'), c('7', 'C'), c('2', 'S'), c('2', 'H'), c('JOKER', null)]);
  });
  it('rejects fewer than 3 cards, too many wilds, and wild-heavy melds', () => {
    assert.throws(() => combineMeld(undefined, '7', [c('7', 'S'), c('7', 'H')]), IllegalMoveError);
    assert.throws(() => combineMeld(undefined, '7', [c('7', 'S'), c('2', 'S'), c('2', 'H')]), IllegalMoveError);
    assert.throws(
      () => combineMeld(undefined, '7', [c('7', 'S'), c('7', 'H'), c('2', 'S'), c('2', 'H'), c('JOKER', null)]),
      IllegalMoveError,
      'naturals must outnumber wilds',
    );
    assert.throws(() => combineMeld(undefined, '7', [c('7', 'S'), c('7', 'H'), c('8', 'D')]), IllegalMoveError);
  });
  it('does not allow wild cards to be added to a completed canasta', () => {
    const canasta = combineMeld(undefined, '9', [
      c('9', 'S'), c('9', 'H'), c('9', 'D'), c('9', 'C'), c('9', 'S', 1), c('9', 'H', 1), c('9', 'D', 1),
    ]);
    assert.throws(() => combineMeld(canasta, '9', [c('2', 'S')]), IllegalMoveError);
    combineMeld(canasta, '9', [c('9', 'C', 1)]); // naturals may be added
  });
});

describe('player view', () => {
  it('hides other hands and the stock', () => {
    const s = newGame(defaultConfig(4), 7);
    const v = viewFor(s, 2);
    assert.deepEqual(v.myHand, s.hands[2]);
    assert.equal(v.handSizes.length, 4);
    assert.equal(v.stockCount, s.stock.length);
    assert.ok(!('hands' in v));
    assert.ok(!('stock' in v));
  });
});
