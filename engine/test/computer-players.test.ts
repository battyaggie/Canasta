// Tests for the computer players in engine/src/bot.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type GameState,
  type BotLevel,
  applyAction,
  botAction,
  defaultConfig,
  mulberry32,
  newGame,
  startNextHand,
  viewFor,
} from '../src/index.js';
import { botTurn as randomBotTurn } from './bot.js';
import { c, checkConservation, scenario } from './helpers.js';

/** Let the computer player finish the current turn. Every action it proposes must be legal. */
function computerTurn(s: GameState, level: BotLevel, rand: () => number): GameState {
  const p = s.turn.player;
  for (let steps = 0; steps < 40; steps++) {
    const action = botAction(viewFor(s, p), level, rand);
    s = applyAction(s, p, action); // throws if the bot ever proposes an illegal move
    if (s.status !== 'playing' || s.turn.player !== p) return s;
  }
  throw new Error('Computer player did not finish its turn in 40 actions');
}

type Player = (s: GameState, rand: () => number) => GameState;
const normal: Player = (s, r) => computerTurn(s, 'normal', r);
const easy: Player = (s, r) => computerTurn(s, 'easy', r);
const random: Player = (s, r) => randomBotTurn(s, r);

/** Plays one whole game; seats on side 0 use `a`, side 1 uses `b`. Returns the winning side. */
function playGame(players: 2 | 4, seed: number, a: Player, b: Player, target = 5000): number {
  const rand = mulberry32(seed * 104729);
  let s = newGame(defaultConfig(players, { targetScore: target }), seed);
  let hands = 1;
  let turns = 0;
  while (s.status !== 'gameOver') {
    if (s.status === 'handOver') {
      s = startNextHand(s, seed * 31 + hands++);
      assert.ok(hands < 80, `seed ${seed}: too many hands`);
      continue;
    }
    const side = players === 2 ? s.turn.player : s.turn.player % 2;
    s = (side === 0 ? a : b)(s, rand);
    checkConservation(s);
    assert.ok(++turns < 20000, `seed ${seed}: game did not finish`);
  }
  return s.winner!;
}

describe('computer players: whole games', () => {
  for (const players of [2, 4] as const) {
    it(`${players} players: 200 games of Normal vs Normal, every move legal, every game finishes`, () => {
      for (let seed = 1; seed <= 200; seed++) playGame(players, seed, normal, normal, 1500);
    });
    it(`${players} players: Easy plays legal moves too`, () => {
      for (let seed = 1; seed <= 50; seed++) playGame(players, seed, easy, normal, 1500);
    });
    it(`${players} players: Normal clearly beats the random test bot`, () => {
      let wins = 0;
      const games = 100;
      for (let seed = 1; seed <= games; seed++) {
        // Swap sides every other game so seat order does not matter.
        const normalSide = seed % 2;
        const w = normalSide === 0 ? playGame(players, seed, normal, random, 1500) : playGame(players, seed, random, normal, 1500);
        if (w === normalSide) wins++;
      }
      console.log(`${players}-player: Normal won ${wins} of ${games} against the random bot`);
      assert.ok(wins >= 70, `Normal won only ${wins} of ${games}`);
    });
  }
});

describe('computer players: decisions', () => {
  it('makes a first meld that reaches the minimum, using a pair and a wild card if needed', () => {
    // 50 needed. Three kings = 30, not enough; adding the queen pair with a joker = 30 + 20 + 50.
    const s = scenario({
      hands: [[c('K', 'S'), c('K', 'H'), c('K', 'D'), c('Q', 'S'), c('Q', 'H'), c('JOKER'), c('4', 'S'), c('9', 'C')], []],
      phase: 'play',
    });
    const a = botAction(viewFor(s, 0));
    assert.equal(a.type, 'meld');
    const after = applyAction(s, 0, a);
    assert.ok(after.sides[0].melds.length >= 1);
  });

  it('does not meld when the first meld cannot reach the minimum', () => {
    const s = scenario({
      hands: [[c('4', 'S'), c('4', 'H'), c('4', 'D'), c('9', 'C'), c('J', 'D')], []],
      phase: 'play',
    });
    assert.equal(botAction(viewFor(s, 0)).type, 'discard');
  });

  it('takes a frozen pile with no wild cards when the top card matches its meld (house rule)', () => {
    const s = scenario({
      hands: [[c('4', 'S'), c('9', 'C'), c('J', 'D')], []],
      melds: [[[c('8', 'S'), c('8', 'H'), c('8', 'D')]], []],
      pile: [c('2', 'C'), c('5', 'H'), c('8', 'C')],
      pileFrozen: true,
    });
    const a = botAction(viewFor(s, 0));
    assert.deepEqual(a, { type: 'takePile', melds: [] });
    applyAction(s, 0, a);
  });

  it('draws instead of taking the pile when the top card matches a finished canasta', () => {
    const canasta = [c('8', 'S'), c('8', 'H'), c('8', 'D'), c('8', 'C'), c('8', 'S', 1), c('8', 'H', 1), c('8', 'D', 1)];
    const s = scenario({
      hands: [[c('4', 'S'), c('9', 'C'), c('J', 'D')], []],
      melds: [[canasta], []],
      pile: [c('5', 'H'), c('6', 'H'), c('8', 'C', 1)],
    });
    assert.equal(botAction(viewFor(s, 0)).type, 'drawStock');
  });

  it('goes out with black threes when it has a canasta', () => {
    const canasta = [c('8', 'S'), c('8', 'H'), c('8', 'D'), c('8', 'C'), c('8', 'S', 1), c('8', 'H', 1), c('8', 'D', 1)];
    const s = scenario({
      hands: [[c('3', 'S'), c('3', 'C'), c('3', 'S', 1), c('9', 'C')], []],
      melds: [[canasta], []],
      phase: 'play',
    });
    let st = s;
    for (let i = 0; i < 3 && st.status === 'playing'; i++) st = applyAction(st, 0, botAction(viewFor(st, 0)));
    assert.equal(st.status, 'handOver');
    assert.equal(st.handResult?.wentOutPlayer, 0);
  });

  it('uses wild cards to finish its first canasta', () => {
    const s = scenario({
      hands: [[c('JOKER'), c('2', 'S'), c('4', 'S'), c('9', 'C'), c('J', 'D')], []],
      melds: [[[c('K', 'S'), c('K', 'H'), c('K', 'D'), c('K', 'C'), c('K', 'S', 1)]], []],
      phase: 'play',
    });
    const after = applyAction(s, 0, botAction(viewFor(s, 0)));
    assert.equal(after.sides[0].melds[0]!.cardIds.length, 7);
  });

  it('keeps its last card when it has no canasta', () => {
    const s = scenario({
      hands: [[c('9', 'C')], []],
      melds: [[[c('K', 'S'), c('K', 'H'), c('K', 'D')]], []],
      phase: 'play',
    });
    assert.deepEqual(botAction(viewFor(s, 0)), { type: 'skipDiscard' });
  });

  it('prefers a black three as its discard, and avoids feeding the next player’s meld', () => {
    const s = scenario({
      hands: [[c('3', 'S'), c('7', 'H'), c('9', 'C')], []],
      melds: [[[c('K', 'S'), c('K', 'H'), c('K', 'D')]], [[c('9', 'S'), c('9', 'H'), c('9', 'D')]]],
      phase: 'play',
    });
    assert.deepEqual(botAction(viewFor(s, 0)), { type: 'discard', cardId: c('3', 'S') });
    const s2 = scenario({
      hands: [[c('7', 'H'), c('9', 'C')], []],
      melds: [[[c('K', 'S'), c('K', 'H'), c('K', 'D')]], [[c('9', 'S'), c('9', 'H'), c('9', 'D')]]],
      phase: 'play',
    });
    assert.deepEqual(botAction(viewFor(s2, 0)), { type: 'discard', cardId: c('7', 'H') });
  });

  it('copes with a live table, where only the top card of the pile is visible', () => {
    const s = scenario({
      hands: [[c('4', 'S'), c('9', 'C'), c('J', 'D')], []],
      melds: [[[c('8', 'S'), c('8', 'H'), c('8', 'D')]], []],
      pile: [c('5', 'H'), c('6', 'H'), c('8', 'C')],
    });
    const v = viewFor(s, 0);
    v.pile = v.pile.map((id, i, all) => (i === all.length - 1 ? id : -1));
    assert.deepEqual(botAction(v), { type: 'takePile', melds: [] });
  });

  it('decides quickly enough for a headset (well under 10 ms per action)', () => {
    let s = newGame(defaultConfig(4), 7);
    const rand = mulberry32(1);
    let actions = 0;
    const t0 = performance.now();
    while (s.status === 'playing' && actions < 400) {
      const p = s.turn.player;
      s = applyAction(s, p, botAction(viewFor(s, p), 'normal', rand));
      actions++;
    }
    const per = (performance.now() - t0) / actions;
    assert.ok(per < 10, `${per.toFixed(2)} ms per action`);
  });
});
