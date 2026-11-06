// Full random games. A deliberately simple bot plays legal-ish moves (and falls
// back when a move is rejected) so we can check, across thousands of turns, that
// the engine never loses or duplicates a card, never wedges, and always finishes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, mulberry32, newGame, startNextHand } from '../src/index.js';
import { botTurn } from './bot.js';
import { checkConservation } from './helpers.js';

function playGame(players: 2 | 4, seed: number): { hands: number; turns: number; finished: boolean; wentOut: number } {
  const rand = mulberry32(seed * 7919);
  let s = newGame(defaultConfig(players, { targetScore: 1500 }), seed);
  let turns = 0;
  let hands = 1;
  let wentOut = 0;
  while (s.status !== 'gameOver') {
    if (s.status === 'handOver') {
      if (s.handResult?.endedBy === 'wentOut') wentOut++;
      s = startNextHand(s, seed * 31 + hands);
      hands++;
      if (hands > 60) return { hands, turns, finished: false, wentOut };
      continue;
    }
    s = botTurn(s, rand);
    checkConservation(s);
    if (++turns > 6000) return { hands, turns, finished: false, wentOut };
  }
  return { hands, turns, finished: true, wentOut };
}

describe('random-bot simulations', () => {
  for (const players of [2, 4] as const) {
    it(`${players}-player games always run to completion without losing cards`, () => {
      let totalOut = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const r = playGame(players, seed);
        assert.ok(r.finished, `${players}p seed ${seed} did not finish (${r.turns} turns, ${r.hands} hands)`);
        totalOut += r.wentOut;
      }
      console.log(`${players}-player: hands ended by going out across 40 games = ${totalOut}`);
    });
  }
});
