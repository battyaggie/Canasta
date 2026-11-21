import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, sideOf } from '../../engine/src/index.js';
import { botTurn } from '../../engine/test/bot.js';
import { checkConservation } from '../../engine/test/helpers.js';
import { ProtocolError, parseClientMsg, parseSettings } from '../../shared/protocol.js';
import { Room, RoomError, type RoomDeps } from '../room.js';

function deps(seed = 1): RoomDeps {
  const rand = mulberry32(seed);
  let clock = 1_000;
  return {
    now: () => (clock += 10),
    randomSeed: () => Math.floor(rand() * 2 ** 31),
    randomToken: () => `tok-${Math.floor(rand() * 1e9)}`,
  };
}

function fullRoom(players: 2 | 4, seed = 1): { room: Room; tokens: string[] } {
  const room = Room.create('ABCD', { players, mode: 'live', targetScore: 1500 }, deps(seed));
  const tokens: string[] = [];
  for (let i = 0; i < players; i++) tokens.push(room.join(`P${i}`, undefined).token);
  return { room, tokens };
}

describe('lobby', () => {
  it('seats players in order and rejects extras', () => {
    const room = Room.create('ABCD', { players: 2, mode: 'live', targetScore: 5000 }, deps());
    assert.equal(room.join('Mark', undefined).seat, 0);
    assert.equal(room.join('Anna', undefined).seat, 1);
    assert.throws(() => room.join('Third', undefined), RoomError);
  });

  it('remembers the figure each player chose for the 3D table, and a new choice on return', () => {
    const room = Room.create('ABCD', { players: 2, mode: 'live', targetScore: 5000 }, deps());
    const mark = room.join('Mark', undefined, 'man');
    room.join('Anna', undefined);
    assert.deepEqual(room.info([true, true]).seats.map((s) => s?.figure), ['man', undefined]);
    room.join(undefined, mark.token, 'woman');
    assert.equal(room.info([true, true]).seats[0]?.figure, 'woman');
    assert.deepEqual(parseClientMsg('{"t":"hello","name":"A","figure":"woman"}'), { t: 'hello', token: undefined, name: 'A', figure: 'woman' });
    assert.deepEqual(parseClientMsg('{"t":"hello","figure":"dragon"}'), { t: 'hello', token: undefined, name: undefined });
  });

  it('lets a player return to their seat with their token, even after the game starts', () => {
    const { room, tokens } = fullRoom(4);
    room.start(0);
    assert.deepEqual(room.join(undefined, tokens[2]), { seat: 2, token: tokens[2] });
    assert.throws(() => room.join('Stranger', undefined), RoomError);
    assert.throws(() => room.join('Stranger', 'wrong-token'), RoomError);
  });

  it('a player on a new device can take back their seat in a started game, but only if it is free', () => {
    const { room, tokens } = fullRoom(2);
    room.start(0);
    // Mum's phone forgot its seat; Mark is at the table, Mum is not.
    assert.deepEqual(room.join(undefined, undefined, undefined, { seat: 1, connected: [true, false] }), { seat: 1, token: tokens[1] });
    // The old token keeps working too, so her other device is not locked out.
    assert.deepEqual(room.join(undefined, tokens[1]), { seat: 1, token: tokens[1] });
    // Someone already sitting there now cannot be pushed out.
    assert.throws(() => room.join(undefined, undefined, undefined, { seat: 0, connected: [true, false] }), /at the table right now/);
    assert.throws(() => room.join(undefined, undefined, undefined, { seat: 3, connected: [] }), RoomError);
    // In the lobby a claim is not needed: you simply sit down.
    const lobby = Room.create('WXYZ', { players: 2, mode: 'live', targetScore: 1500 }, deps(2));
    assert.equal(lobby.join('Anna', undefined, undefined, { seat: 1, connected: [] }).seat, 0);
  });

  it('cleans names and defaults empty ones', () => {
    const room = Room.create('ABCD', { players: 4, mode: 'async', targetScore: 5000 }, deps());
    room.join('  <b>Mark</b>  ', undefined);
    room.join('', undefined);
    room.join('x'.repeat(100), undefined);
    assert.equal(room.data.seats[0]!.name, 'bMark/b');
    assert.equal(room.data.seats[1]!.name, 'Player 2');
    assert.equal(room.data.seats[2]!.name.length, 20);
  });

  it('only the host can start, and only once the table is full', () => {
    const room = Room.create('ABCD', { players: 4, mode: 'live', targetScore: 5000 }, deps());
    room.join('A', undefined);
    room.join('B', undefined);
    assert.throws(() => room.start(0), /more player/);
    room.join('C', undefined);
    room.join('D', undefined);
    assert.throws(() => room.start(1), /host/);
    room.start(0);
    assert.equal(room.data.phase, 'playing');
    assert.throws(() => room.start(0), RoomError);
  });

  it('reports teams: seats 0 and 2 are partners in a 4-player game', () => {
    const { room } = fullRoom(4);
    room.start(0);
    const cfg = room.data.game!.config;
    assert.equal(sideOf(cfg, 0), sideOf(cfg, 2));
    assert.notEqual(sideOf(cfg, 0), sideOf(cfg, 1));
  });
});

describe('playing', () => {
  it('only the player whose turn it is can act', () => {
    const { room } = fullRoom(2);
    room.start(0);
    const turn = room.data.game!.turn.player;
    const other = 1 - turn;
    assert.throws(() => room.act(other, { type: 'drawStock' }), /Not your turn/);
    room.act(turn, { type: 'drawStock' });
    assert.equal(room.data.game!.turn.phase, 'play');
  });

  it('refuses actions before the game starts', () => {
    const { room } = fullRoom(2);
    assert.throws(() => room.act(0, { type: 'drawStock' }), RoomError);
  });

  it("never reveals another player's hand or the stock in a view", () => {
    const { room } = fullRoom(4);
    room.start(0);
    const game = room.data.game!;
    for (let seat = 0; seat < 4; seat++) {
      const view = room.viewFor(seat)!;
      const text = JSON.stringify(view);
      assert.deepEqual(view.myHand, game.hands[seat]);
      for (let other = 0; other < 4; other++) {
        if (other === seat) continue;
        // None of the other player's card ids may appear as "myHand"; counts only.
        assert.equal(view.handSizes[other], game.hands[other]!.length);
      }
      assert.ok(!text.includes('"stock"'), 'no stock array in view');
      assert.ok(!text.includes('"hands"'), 'no hands array in view');
    }
  });

  it('live tables show only the top of the discard pile; take-turns tables show all of it', () => {
    for (const mode of ['live', 'async'] as const) {
      const room = Room.create('ABCD', { players: 2, mode, targetScore: 5000 }, deps(4));
      room.join('A', undefined);
      room.join('B', undefined);
      room.start(0);
      const rand = mulberry32(5);
      const apply = (_s: unknown, p: number, a: Parameters<Room['act']>[1]) => {
        room.act(p, a);
        return room.data.game!;
      };
      for (let i = 0; i < 6 && room.data.game!.pile.length < 4; i++) botTurn(room.data.game!, rand, apply);
      const real = room.data.game!.pile;
      assert.ok(real.length >= 4, 'the pile has several cards to hide');
      for (const seat of [0, 1]) {
        const seen = room.viewFor(seat)!.pile;
        assert.equal(seen.length, real.length, 'the size of the pile is always visible');
        assert.equal(seen.at(-1), real.at(-1), 'the top card is always visible');
        if (mode === 'live') {
          assert.ok(seen.slice(0, -1).every((id) => id === -1), 'live: cards under the top are hidden');
          for (const id of real.slice(0, -1)) assert.ok(!JSON.stringify(room.viewFor(seat)).includes(`,${id},`), 'and never sent');
        } else {
          assert.deepEqual(seen, real, 'take-turns: the whole pile can be looked through');
        }
      }
    }
  });

  it('survives being saved and restored as JSON in the middle of a game', () => {
    const { room, tokens } = fullRoom(4, 5);
    room.start(0);
    const rand = mulberry32(99);
    let restored = room;
    for (let i = 0; i < 40; i++) {
      const snapshot = JSON.parse(JSON.stringify(restored.data));
      restored = new Room(snapshot, deps(i + 10));
      botTurn(restored.data.game!, rand, (_s, p, a) => {
        restored.act(p, a);
        return restored.data.game!;
      });
      checkConservation(restored.data.game!);
    }
    assert.deepEqual(restored.join(undefined, tokens[3]), { seat: 3, token: tokens[3] });
  });
});

describe('whole games through the room', () => {
  for (const players of [2, 4] as const) {
    it(`${players}-player game: hands, next hand, game over, rematch`, () => {
      const { room } = fullRoom(players, 3 + players);
      room.start(0);
      const rand = mulberry32(players * 101);
      let turns = 0;
      let handsPlayed = 0;
      const apply = (_s: unknown, p: number, a: Parameters<Room['act']>[1]) => {
        room.act(p, a);
        return room.data.game!;
      };
      while (room.data.phase === 'playing') {
        const g = room.data.game!;
        if (g.status === 'handOver') {
          handsPlayed++;
          room.nextHand();
          room.nextHand(); // a second click is harmless
          continue;
        }
        botTurn(g, rand, apply);
        checkConservation(room.data.game!);
        assert.ok(++turns < 8000, 'game did not finish');
      }
      assert.equal(room.data.phase, 'finished');
      assert.ok(room.data.game!.winner === 0 || room.data.game!.winner === 1);
      // A game that ends mid-hand goes straight to game over, so hand N+1 is the last one dealt.
      assert.equal(room.data.game!.handNumber, handsPlayed + 1);
      room.rematch();
      assert.equal(room.data.phase, 'playing');
      assert.deepEqual(room.data.game!.scores, [0, 0]);
    });
  }

  it('room info shows who is connected', () => {
    const { room } = fullRoom(2);
    const info = room.info([true, false]);
    assert.deepEqual(info.seats, [
      { name: 'P0', connected: true },
      { name: 'P1', connected: false },
    ]);
  });
});

describe('untrusted input', () => {
  it('accepts well-formed messages', () => {
    assert.deepEqual(parseClientMsg('{"t":"start"}'), { t: 'start' });
    assert.deepEqual(parseClientMsg('{"t":"action","action":{"type":"discard","cardId":5}}'), {
      t: 'action',
      action: { type: 'discard', cardId: 5 },
    });
    assert.deepEqual(
      parseClientMsg('{"t":"action","action":{"type":"meld","melds":[{"rank":"K","cardIds":[1,2,3]}]}}'),
      { t: 'action', action: { type: 'meld', melds: [{ rank: 'K', cardIds: [1, 2, 3] }] } },
    );
  });

  it('rejects malformed messages without throwing anything else', () => {
    const bad = [
      'not json',
      '[]',
      '{}',
      '{"t":"launch"}',
      '{"t":"action"}',
      '{"t":"action","action":{"type":"discard","cardId":"5"}}',
      '{"t":"action","action":{"type":"discard","cardId":999}}',
      '{"t":"action","action":{"type":"discard","cardId":-1}}',
      '{"t":"action","action":{"type":"discard","cardId":1.5}}',
      '{"t":"action","action":{"type":"meld","melds":[{"rank":"Z","cardIds":[1,2,3]}]}}',
      '{"t":"action","action":{"type":"meld","melds":[{"rank":"K","cardIds":"x"}]}}',
      '{"t":"action","action":{"type":"meld","melds":"x"}}',
      '{"t":"action","action":{"type":"cheat"}}',
      '{"t":"x"'.padEnd(9000, 'x'),
    ];
    for (const text of bad) assert.throws(() => parseClientMsg(text), ProtocolError, text.slice(0, 60));
  });

  it('validates room settings', () => {
    assert.deepEqual(parseSettings({ players: 4, mode: 'async' }), { players: 4, mode: 'async', targetScore: 5000 });
    assert.throws(() => parseSettings({ players: 3, mode: 'live' }), ProtocolError);
    assert.throws(() => parseSettings({ players: 2, mode: 'turbo' }), ProtocolError);
    assert.throws(() => parseSettings({ players: 2, mode: 'live', targetScore: 5 }), ProtocolError);
    assert.throws(() => parseSettings(null), ProtocolError);
  });

  it('a forged duplicate-card move is rejected by the engine, not applied', () => {
    const { room } = fullRoom(2);
    room.start(0);
    const turn = room.data.game!.turn.player;
    room.act(turn, { type: 'drawStock' });
    const card = room.data.game!.hands[turn]![0]!;
    const before = JSON.stringify(room.data.game);
    assert.throws(() => room.act(turn, { type: 'meld', melds: [{ rank: '7', cardIds: [card, card, card] }] }), RoomError);
    assert.equal(JSON.stringify(room.data.game), before, 'state unchanged after a rejected move');
  });
});
