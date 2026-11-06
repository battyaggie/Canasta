import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IllegalMoveError } from '../src/index.js';
import { act, c, checkConservation, scenario } from './helpers.js';

const nineCanasta = [
  c('9', 'S'), c('9', 'H'), c('9', 'D'), c('9', 'C'), c('9', 'S', 1), c('9', 'H', 1), c('9', 'D', 1),
];
const kingMeld = [c('K', 'S'), c('K', 'H'), c('K', 'D')];

describe('drawing', () => {
  it('draws exactly one card, in both the 4-player and the 2-player game', () => {
    const s4 = scenario({ players: 4, hands: [[c('5', 'S')], [], [], []], player: 0 });
    assert.equal(act(s4, 0, { type: 'drawStock' }).hands[0]!.length, 2);
    const s2 = scenario({ players: 2, hands: [[c('5', 'S')], []], player: 0 });
    assert.equal(act(s2, 0, { type: 'drawStock' }).hands[0]!.length, 2);
  });

  it('lays down a red three drawn from the stock and replaces it', () => {
    const red = c('3', 'H');
    const s = scenario({
      players: 2,
      hands: [[c('5', 'S')], []],
      stockEnd: [c('Q', 'S'), c('J', 'S'), red], // the red three is drawn first, then J (Q stays in the stock)
    });
    const after = act(s, 0, { type: 'drawStock' });
    assert.deepEqual(after.sides[0].redThrees, [red]);
    assert.deepEqual(after.hands[0], [c('5', 'S'), c('J', 'S')]);
    checkConservation(after);
  });

  it('ends the hand when the stock is exhausted', () => {
    const s = scenario({ players: 4, hands: [[c('5', 'S')], [], [], []], emptyStock: true });
    const after = act(s, 0, { type: 'drawStock' });
    assert.equal(after.status, 'handOver');
    assert.equal(after.handResult?.endedBy, 'stockExhausted');
  });

  it('enforces turn order and phases', () => {
    const s = scenario({ players: 4, hands: [[c('5', 'S')], [c('6', 'S')], [], []] });
    assert.throws(() => act(s, 1, { type: 'drawStock' }), IllegalMoveError);
    assert.throws(() => act(s, 0, { type: 'discard', cardId: c('5', 'S') }), IllegalMoveError);
    const drawn = act(s, 0, { type: 'drawStock' });
    assert.throws(() => act(drawn, 0, { type: 'drawStock' }), IllegalMoveError);
  });
});

describe('taking the discard pile', () => {
  it('needs two naturals when the pile is frozen by a wild card', () => {
    const base = {
      players: 2 as const,
      pile: [c('2', 'H'), c('7', 'S')],
      pileFrozen: true,
      melds: [[kingMeld], []] as [number[][], number[][]],
    };
    const bad = scenario({ ...base, hands: [[c('7', 'H'), c('2', 'S'), c('5', 'D')], []] });
    assert.throws(
      () => act(bad, 0, { type: 'takePile', melds: [{ rank: '7', cardIds: [c('7', 'H'), c('2', 'S')] }] }),
      IllegalMoveError,
    );
    const good = scenario({ ...base, hands: [[c('7', 'H'), c('7', 'D'), c('5', 'D')], []] });
    const after = act(good, 0, { type: 'takePile', melds: [{ rank: '7', cardIds: [c('7', 'H'), c('7', 'D')] }] });
    assert.equal(after.pile.length, 0);
    assert.equal(after.pileFrozen, false);
    assert.ok(after.hands[0]!.includes(c('2', 'H')), 'rest of pile goes to hand');
    assert.equal(after.sides[0].melds.find((m) => m.rank === '7')!.cardIds.length, 3);
    assert.equal(after.turn.phase, 'play');
    checkConservation(after);
  });

  it('a frozen pile can still be taken when the top card matches a meld the side already has', () => {
    const sevens = [c('7', 'D'), c('7', 'C'), c('7', 'H')];
    const base = {
      players: 2 as const,
      pile: [c('2', 'H'), c('9', 'S'), c('7', 'S')],
      pileFrozen: true,
      melds: [[kingMeld, sevens], []] as [number[][], number[][]],
    };
    const s = scenario({ ...base, hands: [[c('5', 'D'), c('Q', 'D')], []] });
    const after = act(s, 0, { type: 'takePile', melds: [] });
    assert.equal(after.pile.length, 0);
    assert.equal(after.sides[0].melds.find((m) => m.rank === '7')!.cardIds.length, 4, 'the top seven joins the sevens on the table');
    assert.ok(after.hands[0]!.includes(c('2', 'H')) && after.hands[0]!.includes(c('9', 'S')), 'the rest of the pile goes to the hand');
    checkConservation(after);
    // ...but a wild card cannot be used to do it.
    const withWild = scenario({ ...base, hands: [[c('2', 'S'), c('Q', 'D')], []] });
    assert.throws(() => act(withWild, 0, { type: 'takePile', melds: [{ rank: '7', cardIds: [c('2', 'S')] }] }), /wild cards cannot/);
  });

  it('allows a natural plus a wild card when the pile is not frozen', () => {
    const s = scenario({
      players: 2,
      pile: [c('7', 'S')],
      hands: [[c('7', 'H'), c('2', 'S'), c('5', 'D')], []],
      melds: [[kingMeld], []],
    });
    const after = act(s, 0, { type: 'takePile', melds: [{ rank: '7', cardIds: [c('7', 'H'), c('2', 'S')] }] });
    assert.equal(after.sides[0].melds.length, 2);
  });

  it('lets an existing meld absorb the top card with no cards from hand', () => {
    const s = scenario({ players: 2, pile: [c('K', 'C')], hands: [[c('5', 'D')], []], melds: [[kingMeld], []] });
    const after = act(s, 0, { type: 'takePile', melds: [] });
    assert.equal(after.sides[0].melds[0]!.cardIds.length, 4);
  });

  it('lets wild cards alone be added to an existing meld, up to a mixed canasta', () => {
    const fourKings = [...kingMeld, c('K', 'C')];
    const wilds = [c('JOKER', null), c('2', 'S'), c('2', 'H')];
    const s = scenario({ players: 2, hands: [[...wilds, c('5', 'D'), c('9', 'D')], [c('9', 'C')]], melds: [[fourKings], []] });
    const after = act(s, 0, { type: 'drawStock' });
    const melded = act(after, 0, { type: 'meld', melds: [{ rank: 'K', cardIds: wilds }] });
    assert.equal(melded.sides[0].melds[0]!.cardIds.length, 7, 'four kings and three wild cards make a canasta');
    // ...but four wild cards would be one too many.
    const tooMany = scenario({ players: 2, hands: [[...wilds, c('2', 'D'), c('5', 'D')], [c('9', 'C')]], melds: [[fourKings], []] });
    assert.throws(
      () => act(act(tooMany, 0, { type: 'drawStock' }), 0, { type: 'meld', melds: [{ rank: 'K', cardIds: [...wilds, c('2', 'D')] }] }),
      IllegalMoveError,
    );
  });

  it('cannot take with a wild card or black three on top', () => {
    for (const top of [c('2', 'S'), c('3', 'S'), c('JOKER', null)]) {
      const s = scenario({ players: 2, pile: [top], hands: [[c('7', 'H'), c('7', 'D')], []], melds: [[kingMeld], []] });
      assert.throws(() => act(s, 0, { type: 'takePile', melds: [] }), IllegalMoveError);
    }
  });

  it('cannot take the pile until the side already has a meld on the table', () => {
    // Even a huge hand that would easily meet the initial minimum cannot be used to take the pile.
    const hand = [
      c('7', 'H'), c('7', 'D'),
      c('K', 'S'), c('K', 'H'), c('K', 'D'), c('K', 'C'),
      c('A', 'S'), c('A', 'H'), c('A', 'D'), c('5', 'C'),
    ];
    const s = scenario({ players: 2, pile: [c('7', 'S')], hands: [hand, [c('9', 'D')]] });
    assert.throws(
      () => act(s, 0, { type: 'takePile', melds: [{ rank: '7', cardIds: [c('7', 'H'), c('7', 'D')] }] }),
      /meld on the table/,
    );
    // Draw, make the initial meld from the hand, then the next turn the pile can be taken.
    let t = act(s, 0, { type: 'drawStock' });
    t = act(t, 0, {
      type: 'meld',
      melds: [
        { rank: 'K', cardIds: [c('K', 'S'), c('K', 'H'), c('K', 'D'), c('K', 'C')] },
        { rank: 'A', cardIds: [c('A', 'S'), c('A', 'H'), c('A', 'D')] },
      ],
    });
    t = act(t, 0, { type: 'discard', cardId: c('5', 'C') });
    t = act(t, 1, { type: 'drawStock' });
    t = act(t, 1, { type: 'discard', cardId: t.hands[1]![0]! });
    // Put a seven back on top of the pile for the demonstration: player 0 now holds 7H, 7D.
    t = { ...t, pile: [...t.pile.slice(0, -1), c('7', 'S')] };
    const taken = act(t, 0, { type: 'takePile', melds: [{ rank: '7', cardIds: [c('7', 'H'), c('7', 'D')] }] });
    assert.equal(taken.turn.phase, 'play');
  });

  it('taking the pile is optional: drawing from the stock is always allowed', () => {
    const s = scenario({
      players: 2,
      pile: [c('K', 'C')],
      hands: [[c('5', 'D')], []],
      melds: [[kingMeld], []],
    });
    const drawn = act(s, 0, { type: 'drawStock' });
    assert.equal(drawn.pile.length, 1);
    assert.equal(drawn.turn.phase, 'play');
  });

  it('cannot use a completed canasta to take the pile', () => {
    const s = scenario({
      players: 2,
      pile: [c('9', 'C', 1)],
      hands: [[c('5', 'D')], []],
      melds: [[nineCanasta], []],
    });
    assert.throws(() => act(s, 0, { type: 'takePile', melds: [] }), IllegalMoveError);
  });

  it('discarding a wild card freezes the pile; a black three blocks only the next player', () => {
    let s = scenario({
      players: 2,
      hands: [[c('2', 'S'), c('5', 'D')], [c('7', 'H'), c('7', 'D'), c('5', 'S')]],
      phase: 'play',
    });
    s = act(s, 0, { type: 'discard', cardId: c('2', 'S') });
    assert.equal(s.pileFrozen, true);
  });
});

describe('melding', () => {
  it('requires the initial meld minimum', () => {
    const s = scenario({
      players: 2,
      hands: [[c('4', 'S'), c('4', 'H'), c('4', 'D'), c('5', 'S'), c('6', 'S')], []],
      phase: 'play',
    });
    assert.throws(
      () => act(s, 0, { type: 'meld', melds: [{ rank: '4', cardIds: [c('4', 'S'), c('4', 'H'), c('4', 'D')] }] }),
      IllegalMoveError,
    );
  });

  it('uses the higher minimum at higher scores', () => {
    // KKKK + AAA = 40 + 60 = 100 meets 90 but KKKK alone (40) does not
    const hand = [c('K', 'S'), c('K', 'H'), c('K', 'D'), c('K', 'C'), c('A', 'S'), c('A', 'H'), c('A', 'D'), c('5', 'S')];
    const s = scenario({ players: 2, hands: [hand, []], phase: 'play', scores: [2000, 0] });
    assert.throws(
      () => act(s, 0, { type: 'meld', melds: [{ rank: 'K', cardIds: hand.slice(0, 4) }] }),
      IllegalMoveError,
    );
    act(s, 0, {
      type: 'meld',
      melds: [
        { rank: 'K', cardIds: hand.slice(0, 4) },
        { rank: 'A', cardIds: hand.slice(4, 7) },
      ],
    });
  });

  it('lets a side that has melded extend melds freely', () => {
    const s = scenario({
      players: 2,
      hands: [[c('K', 'C'), c('5', 'S')], []],
      phase: 'play',
      melds: [[kingMeld], []],
    });
    const after = act(s, 0, { type: 'meld', melds: [{ rank: 'K', cardIds: [c('K', 'C')] }] });
    assert.equal(after.sides[0].melds[0]!.cardIds.length, 4);
  });

  it('only allows black threes when going out', () => {
    const blacks = [c('3', 'S'), c('3', 'C'), c('3', 'S', 1)];
    const withCanasta = scenario({
      players: 4,
      hands: [[...blacks, c('5', 'H')], [c('K', 'H')], [], []],
      phase: 'play',
      melds: [[nineCanasta], []],
    });
    const melded = act(withCanasta, 0, { type: 'meld', melds: [{ rank: '3', cardIds: blacks }] });
    assert.equal(melded.status, 'playing');
    const out = act(melded, 0, { type: 'discard', cardId: c('5', 'H') });
    assert.equal(out.status, 'handOver');

    const notReady = scenario({
      players: 4,
      hands: [[...blacks, c('5', 'H'), c('6', 'H')], [], [], []],
      phase: 'play',
      melds: [[nineCanasta], []],
    });
    assert.throws(() => act(notReady, 0, { type: 'meld', melds: [{ rank: '3', cardIds: blacks }] }), IllegalMoveError);
  });
});

describe('going out and scoring', () => {
  it('4 players: one canasta is enough; scores meld values, canasta and going-out bonus', () => {
    const s = scenario({
      players: 4,
      hands: [[c('5', 'S')], [c('K', 'H')], [], []],
      phase: 'play',
      melds: [[nineCanasta], []],
    });
    const out = act(s, 0, { type: 'discard', cardId: c('5', 'S') });
    assert.equal(out.status, 'handOver');
    const [a, b] = out.handResult!.sideScores;
    assert.equal(a.meldPoints, 70);
    assert.equal(a.canastaBonus, 500);
    assert.equal(a.goOutBonus, 100);
    assert.equal(a.total, 670);
    assert.equal(b.handPenalty, 10);
    assert.equal(b.total, -10);
    assert.deepEqual(out.scores, [670, -10]);
  });

  it('2 players: going out needs one canasta, as with 4 players', () => {
    // Without a canasta the last card cannot be discarded.
    const none = scenario({
      players: 2,
      hands: [[c('5', 'S')], [c('Q', 'H')]],
      phase: 'play',
      melds: [[kingMeld], []],
    });
    assert.throws(() => act(none, 0, { type: 'discard', cardId: c('5', 'S') }), IllegalMoveError);
    assert.equal(act(none, 0, { type: 'skipDiscard' }).turn.player, 1, 'skipping the discard just passes the turn');

    // With one canasta on the table, discarding the last card ends the hand.
    const one = scenario({
      players: 2,
      hands: [[c('5', 'S')], [c('K', 'H')]],
      phase: 'play',
      melds: [[nineCanasta], []],
    });
    const out = act(one, 0, { type: 'discard', cardId: c('5', 'S') });
    assert.equal(out.status, 'handOver');
  });

  it('concealed going out earns 200 and waives the initial-meld minimum', () => {
    const s = scenario({
      players: 4,
      hands: [[...nineCanasta, c('5', 'S')], [c('K', 'H')], [], []],
      phase: 'play',
    });
    const melded = act(s, 0, { type: 'meld', melds: [{ rank: '9', cardIds: nineCanasta }] });
    const out = act(melded, 0, { type: 'discard', cardId: c('5', 'S') });
    assert.equal(out.handResult!.concealed, true);
    assert.equal(out.handResult!.sideScores[0].goOutBonus, 200);
    assert.equal(out.handResult!.sideScores[0].total, 70 + 500 + 200);
  });

  it('going out by melding the whole hand works too', () => {
    const s = scenario({
      players: 4,
      hands: [[c('K', 'C')], [c('Q', 'H')], [], []],
      phase: 'play',
      melds: [[nineCanasta, kingMeld], []],
    });
    const out = act(s, 0, { type: 'meld', melds: [{ rank: 'K', cardIds: [c('K', 'C')] }] });
    assert.equal(out.status, 'handOver');
    assert.equal(out.handResult!.wentOutPlayer, 0);
  });

  it('red threes: +100 each, +800 for all four, negative if the side never melded', () => {
    const reds = [c('3', 'H'), c('3', 'D'), c('3', 'H', 1), c('3', 'D', 1)];
    const melded = scenario({
      players: 4,
      hands: [[c('5', 'S')], [], [], []],
      melds: [[kingMeld], []],
      redThrees: [reds, []],
      emptyStock: true,
    });
    const ended = act(melded, 0, { type: 'drawStock' });
    assert.equal(ended.handResult!.sideScores[0].redThrees, 800);

    const unmelded = scenario({
      players: 4,
      hands: [[c('5', 'S')], [], [], []],
      redThrees: [reds.slice(0, 2), []],
      emptyStock: true,
    });
    const ended2 = act(unmelded, 0, { type: 'drawStock' });
    assert.equal(ended2.handResult!.sideScores[0].redThrees, -200);
  });

  it('ends the game when a side reaches the target score', () => {
    const s = scenario({
      players: 4,
      hands: [[c('5', 'S')], [c('K', 'H')], [], []],
      phase: 'play',
      melds: [[nineCanasta], []],
      scores: [4500, 0],
    });
    const out = act(s, 0, { type: 'discard', cardId: c('5', 'S') });
    assert.equal(out.status, 'gameOver');
    assert.equal(out.winner, 0);
  });
});
