import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import worker, { GameRoom } from '../worker.js';
import { FakeState, FakeWS } from './fakes.js';

// The worker's types are internal; the test only needs to hand it compatible fakes.
type AnyRoom = ConstructorParameters<typeof GameRoom>[0];

function newRoom(state = new FakeState()) {
  return { state, room: new GameRoom(state as unknown as AnyRoom, {} as never) };
}

async function init(room: GameRoom, players: 2 | 4 = 2, mode: 'live' | 'async' = 'live') {
  return room.fetch(
    new Request('https://room/init', {
      method: 'POST',
      body: JSON.stringify({ code: 'ABCD', settings: { players, mode } }),
    }),
  );
}

const say = (room: GameRoom, ws: FakeWS, msg: unknown) => room.webSocketMessage(ws as never, JSON.stringify(msg));

/** Connect a socket the way the worker would, then say hello. */
async function sit(room: GameRoom, state: FakeState, name: string, token?: string) {
  const ws = new FakeWS();
  state.acceptWebSocket(ws);
  await say(room, ws, { t: 'hello', name, token });
  return ws;
}

describe('GameRoom (Durable Object)', () => {
  it('creates a room once and reports its info', async () => {
    const { room } = newRoom();
    assert.equal((await room.fetch(new Request('https://room/info'))).status, 404, 'no room before init');
    assert.equal((await init(room)).status, 200);
    assert.equal((await init(room)).status, 409, 'cannot init twice');
    const info = (await (await room.fetch(new Request('https://room/info'))).json()) as Record<string, unknown>;
    assert.deepEqual(info, { settings: { players: 2, mode: 'live', targetScore: 5000 }, phase: 'lobby', seatsTaken: 0 });
  });

  it('seats players, hands out private tokens, and shows presence', async () => {
    const { room, state } = newRoom();
    await init(room);
    const a = await sit(room, state, 'Anna');
    const b = await sit(room, state, 'Ben');
    const wa = a.last('welcome');
    const wb = b.last('welcome');
    assert.deepEqual([wa.seat, wb.seat], [0, 1]);
    assert.notEqual(wa.token, wb.token);

    const update = a.last('update');
    assert.equal(update.you, 0);
    assert.deepEqual(update.room.seats, [
      { name: 'Anna', connected: true },
      { name: 'Ben', connected: true },
    ]);
    assert.equal(update.view, null, 'no game yet');
    // A token must never be broadcast to anyone but its owner.
    assert.ok(!JSON.stringify(a.messages().filter((m) => m.t === 'update')).includes(wb.token));

    // Ben drops off: Anna sees him offline.
    b.close();
    await room.webSocketClose(b as never);
    assert.equal(a.last('update').room.seats[1]!.connected, false);
  });

  it('only the host starts; each player then gets their own cards and nobody else’s', async () => {
    const { room, state } = newRoom();
    await init(room);
    const a = await sit(room, state, 'Anna');
    const b = await sit(room, state, 'Ben');

    b.clear();
    await say(room, b, { t: 'start' });
    assert.equal(b.last('error').message, 'Only the host can start the game.');
    assert.equal(a.messages().filter((m) => m.t === 'error').length, 0, 'errors go only to the sender');

    await say(room, a, { t: 'start' });
    const va = a.last('update').view!;
    const vb = b.last('update').view!;
    assert.equal(va.you, 0);
    assert.equal(vb.you, 1);
    assert.equal(va.myHand.length, 15);
    assert.notDeepEqual(va.myHand, vb.myHand);
    for (const id of vb.myHand) assert.ok(!va.myHand.includes(id), 'hands are disjoint');
    const raw = JSON.stringify(a.messages());
    assert.ok(!raw.includes('"hands"') && !raw.includes('"stock"'), 'no hidden zones on the wire');
  });

  it('applies moves from the right player only, and broadcasts the result', async () => {
    const { room, state } = newRoom();
    await init(room);
    const a = await sit(room, state, 'Anna');
    const b = await sit(room, state, 'Ben');
    await say(room, a, { t: 'start' });
    const turn = a.last('update').view!.turn.player;
    const [mover, other] = turn === 0 ? [a, b] : [b, a];

    other.clear();
    await say(room, other, { t: 'action', action: { type: 'drawStock' } });
    assert.match(other.last('error').message, /Not your turn/);

    await say(room, mover, { t: 'action', action: { type: 'drawStock' } });
    assert.equal(mover.last('update').view!.myHand.length, 16);
    assert.equal(other.last('update').view!.handSizes[turn], 16, 'the other player sees only the count');
  });

  it('survives eviction: a fresh object reloads the game from storage', async () => {
    const { room, state } = newRoom();
    await init(room);
    const a = await sit(room, state, 'Anna');
    const b = await sit(room, state, 'Ben');
    await say(room, a, { t: 'start' });
    const turn = a.last('update').view!.turn.player;
    const [mover, waiter] = turn === 0 ? [a, b] : [b, a];
    await say(room, mover, { t: 'action', action: { type: 'drawStock' } });
    const cardToDiscard = mover.last('update').view!.myHand[0]!;
    const pileBefore = mover.last('update').view!.pile.length;

    // The runtime drops the object from memory; the sockets (and their attachments) live on.
    const reborn = new GameRoom(state as unknown as AnyRoom, {} as never);
    mover.clear();
    waiter.clear();
    await say(reborn, mover, { t: 'action', action: { type: 'discard', cardId: cardToDiscard } });

    assert.equal(mover.messages().filter((m) => m.t === 'error').length, 0, 'discard accepted after reload');
    const afterMover = mover.last('update').view!;
    const afterWaiter = waiter.last('update').view!;
    assert.equal(afterMover.pile.length, pileBefore + 1);
    assert.equal(afterMover.pile.at(-1), cardToDiscard);
    assert.equal(afterMover.turn.player, 1 - turn, 'turn passed to the other player');
    assert.equal(afterWaiter.turn.player, 1 - turn);
    assert.equal(afterWaiter.pile.at(-1), cardToDiscard);
  });

  it('lets a player come back with their token on a new socket', async () => {
    const { room, state } = newRoom();
    await init(room);
    const a = await sit(room, state, 'Anna');
    await sit(room, state, 'Ben');
    const token = a.last('welcome').token;
    a.close();
    await room.webSocketClose(a as never);

    const back = await sit(room, state, 'ignored', token);
    assert.equal(back.last('welcome').seat, 0);
    assert.equal(back.last('update').room.seats[0]!.name, 'Anna');
  });

  it('rejects garbage and unauthenticated sockets without crashing', async () => {
    const { room, state } = newRoom();
    await init(room);
    const ws = new FakeWS();
    state.acceptWebSocket(ws);
    for (const junk of ['not json', '{}', '{"t":"action","action":{"type":"cheat"}}', '[1,2,3]']) {
      await room.webSocketMessage(ws as never, junk);
    }
    assert.ok(ws.messages().every((m) => m.t === 'error'));
    ws.clear();
    await say(room, ws, { t: 'start' });
    assert.equal(ws.last('error').message, 'Join the table first.');
    await room.webSocketMessage(ws as never, new ArrayBuffer(4));
    assert.equal(ws.last('error').message, 'Text messages only.');
  });

  it('turn-based tables keep working with nobody connected', async () => {
    const { room, state } = newRoom();
    await init(room, 2, 'async');
    const a = await sit(room, state, 'Anna');
    const b = await sit(room, state, 'Ben');
    await say(room, a, { t: 'start' });
    a.close();
    b.close();
    await room.webSocketClose(a as never);
    await room.webSocketClose(b as never);
    assert.equal(state.getWebSockets().length, 0);
    assert.ok(state.store.get('room'), 'game is saved for later');

    const later = new GameRoom(state as unknown as AnyRoom, {} as never);
    const tokenA = a.last('welcome').token;
    const back = await sit(later, state, '', tokenA);
    assert.equal(back.last('update').view!.myHand.length, 15);
  });

  it('forgets an abandoned room when the alarm fires, but not while someone is connected', async () => {
    const { room, state } = newRoom();
    await init(room);
    assert.ok(state.alarmAt && state.alarmAt > Date.now(), 'alarm scheduled');
    const ws = await sit(room, state, 'Anna');
    await room.alarm();
    assert.ok(state.store.has('room'), 'kept while connected');
    ws.close();
    await room.alarm();
    assert.equal(state.store.size, 0, 'deleted when abandoned');
  });
});

describe('Worker routes', () => {
  function env() {
    const rooms = new Map<string, { state: FakeState; room: GameRoom }>();
    return {
      rooms,
      ROOMS: {
        idFromName: (name: string) => name,
        get: (id: unknown) => {
          const key = String(id);
          if (!rooms.has(key)) rooms.set(key, newRoom());
          const { room } = rooms.get(key)!;
          return { fetch: (input: string | Request, init?: RequestInit) => room.fetch(new Request(input, init)) };
        },
      },
      ASSETS: { fetch: async (r: Request) => new Response(`asset:${new URL(r.url).pathname}`) },
    };
  }
  const call = (e: ReturnType<typeof env>, path: string, init?: RequestInit) =>
    worker.fetch(new Request(`https://canasta.example${path}`, init), e as never);

  it('creates a table and finds it again', async () => {
    const e = env();
    const res = await call(e, '/api/create', { method: 'POST', body: JSON.stringify({ players: 4, mode: 'async' }) });
    assert.equal(res.status, 200);
    const { code } = (await res.json()) as { code: string };
    assert.match(code, /^[A-HJKMNP-Z2-9]{4}$/);
    const info = await call(e, `/api/room/${code.toLowerCase()}`);
    assert.equal(info.status, 200);
    assert.equal(((await info.json()) as { settings: { players: number } }).settings.players, 4);
  });

  it('rejects bad settings and unknown rooms and routes', async () => {
    const e = env();
    assert.equal((await call(e, '/api/create', { method: 'POST', body: '{"players":3,"mode":"live"}' })).status, 400);
    assert.equal((await call(e, '/api/create', { method: 'POST', body: 'nope' })).status, 400);
    assert.equal((await call(e, '/api/room/ZZZZ')).status, 404);
    assert.equal((await call(e, '/api/other')).status, 404);
    assert.equal((await call(e, '/ws/ABCD')).status, 426, 'plain request to the socket route');
  });

  it('hands out STUN servers for voice chat when no TURN key is set', async () => {
    const res = await call(env(), '/api/ice');
    const body = (await res.json()) as { iceServers: { urls: string[] }[] };
    assert.ok(body.iceServers[0]!.urls.some((u) => u.startsWith('stun:')));
  });

  it('serves everything else from the static assets', async () => {
    const res = await call(env(), '/style.css');
    assert.equal(await res.text(), 'asset:/style.css');
  });
  it('voice chat: shows who is in voice and passes call setup only to the right player', async () => {
    const { room, state } = newRoom();
    await init(room, 4);
    const a = await sit(room, state, 'Anna');
    const b = await sit(room, state, 'Ben');
    const c = await sit(room, state, 'Cleo');
    const saved = JSON.stringify(state.store.get('room'));

    await say(room, a, { t: 'voice', on: true });
    assert.equal(c.last('update').room.seats[0]!.voice, true, 'everyone sees Anna joined voice');
    assert.equal(c.last('update').room.seats[1]!.voice, undefined);

    a.clear();
    b.clear();
    c.clear();
    const offer = { s: 'abc123', sdp: { type: 'offer', sdp: 'v=0 fake' } };
    await say(room, a, { t: 'signal', to: 1, data: offer });
    assert.deepEqual(b.messages(), [{ t: 'signal', from: 0, data: offer }], 'Ben gets the offer, marked as from Anna');
    assert.equal(c.sent.length, 0, 'Cleo hears nothing about it');
    assert.equal(a.sent.length, 0, 'no broadcast for call setup');
    assert.equal(JSON.stringify(state.store.get('room')), saved, 'voice never changes the saved game');

    await say(room, a, { t: 'signal', to: 3, data: offer });
    assert.match(a.last('error').message, /not at the table/, 'cannot signal an empty seat');
    await say(room, a, { t: 'signal', to: 0, data: offer });
    assert.match(a.last('error').message, /not at the table/, 'cannot signal yourself');
    await say(room, a, { t: 'signal', to: 1, data: { s: 'x', sdp: { type: 'pranswer', sdp: '' } } });
    assert.match(a.last('error').message, /Invalid signal/);

    const stranger = new FakeWS();
    state.acceptWebSocket(stranger);
    await say(room, stranger, { t: 'signal', to: 0, data: offer });
    assert.match(stranger.last('error').message, /Join the table first/, 'only seated players can call');

    a.close();
    await room.webSocketClose(a as never);
    assert.equal(b.last('update').room.seats[0]!.voice, undefined, 'leaving the table leaves voice too');
  });
});
