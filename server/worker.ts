// Cloudflare entry point.
//
//   POST /api/create        -> makes a room, returns { code }
//   GET  /api/room/:code    -> { settings, phase, seatsTaken } so the join page can fail early
//   GET  /ws/:code          -> WebSocket into that room's Durable Object
//   everything else         -> the static web app (served from the assets binding)
//
// One Durable Object = one table. It keeps the authoritative game state, so
// every move is checked in one place and hidden hands stay hidden. WebSockets use
// the hibernation API: between moves the object can be evicted from memory
// without dropping anyone's connection, and it costs nothing while it sleeps.
//
// NOTE: written against the documented Cloudflare APIs but not run in this
// environment (no workerd here). The room logic it wraps is fully tested.

import {
  type ClientMsg,
  type ServerMsg,
  ProtocolError,
  parseClientMsg,
  parseSettings,
} from '../shared/protocol.js';
import { Room, RoomError, type RoomData } from './room.js';

// ---- the small slice of the Cloudflare runtime API we use -------------------
// (Declared here so the project typechecks without extra packages. If you install
// @cloudflare/workers-types you can delete these.)

interface WS {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
interface DOStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
}
interface DOState {
  storage: DOStorage;
  acceptWebSocket(ws: WS): void;
  getWebSockets(): WS[];
}
interface DOStub {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DOStub;
}
interface Env {
  ROOMS: DONamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
}
declare const WebSocketPair: new () => { 0: WS; 1: WS };

// ---- the Worker --------------------------------------------------------------

// No 0/O or 1/I/L so codes are easy to read out over the phone.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/create' && request.method === 'POST') {
      let settings;
      try {
        settings = parseSettings(await request.json());
      } catch (e) {
        return json({ error: e instanceof ProtocolError ? e.message : 'Invalid request' }, 400);
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch('https://room/init', {
          method: 'POST',
          body: JSON.stringify({ code, settings }),
        });
        if (res.status === 200) return json({ code });
        if (res.status !== 409) return json({ error: 'Could not create the room' }, 500);
      }
      return json({ error: 'Could not find a free room code, please try again' }, 500);
    }

    const info = path.match(/^\/api\/room\/([A-Za-z0-9]{4})$/);
    if (info && request.method === 'GET') {
      const code = info[1]!.toUpperCase();
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch('https://room/info');
    }

    const ws = path.match(/^\/ws\/([A-Za-z0-9]{4})$/);
    if (ws) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      const code = ws[1]!.toUpperCase();
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch('https://room/ws', request);
    }

    if (path.startsWith('/api/') || path.startsWith('/ws/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

// ---- the Durable Object: one table -------------------------------------------

const KEEP_ROOM_MS = 30 * 24 * 60 * 60 * 1000; // delete a room 30 days after its last activity
const MAX_SOCKETS = 12;

export class GameRoom {
  private room: Room | null = null;

  constructor(
    private state: DOState,
    _env: Env,
  ) {}

  private async load(): Promise<Room | null> {
    if (!this.room) {
      const data = await this.state.storage.get<RoomData>('room');
      if (data) this.room = new Room(data);
    }
    return this.room;
  }

  private async save(): Promise<void> {
    if (!this.room) return;
    await this.state.storage.put('room', this.room.data);
    await this.state.storage.setAlarm(Date.now() + KEEP_ROOM_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      if (await this.load()) return new Response('exists', { status: 409 });
      const body = (await request.json()) as { code: string; settings: unknown };
      this.room = Room.create(body.code, parseSettings(body.settings));
      await this.save();
      return json({ ok: true });
    }

    const room = await this.load();
    if (!room) return json({ error: 'No such room' }, 404);

    if (url.pathname === '/info') {
      return json({
        settings: room.data.settings,
        phase: room.data.phase,
        seatsTaken: room.data.seats.length,
      });
    }

    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      if (this.state.getWebSockets().length >= MAX_SOCKETS) return new Response('Table is busy', { status: 503 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }

    return new Response('Not found', { status: 404 });
  }

  // ---- WebSocket handlers (called by the runtime, also after waking from hibernation)

  async webSocketMessage(ws: WS, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== 'string') return this.sendError(ws, 'Text messages only.');
    const room = await this.load();
    if (!room) return this.sendError(ws, 'No such room.');

    try {
      const msg = parseClientMsg(data);
      const changed = this.handle(room, ws, msg);
      if (changed) await this.save();
      this.broadcast(room);
    } catch (e) {
      if (e instanceof RoomError || e instanceof ProtocolError) this.sendError(ws, e.message);
      else {
        console.error('Unexpected error handling message', e);
        this.sendError(ws, 'Something went wrong on the server.');
      }
    }
  }

  async webSocketClose(ws: WS): Promise<void> {
    const room = await this.load();
    if (room) this.broadcast(room, ws);
  }

  async webSocketError(ws: WS): Promise<void> {
    const room = await this.load();
    if (room) this.broadcast(room, ws);
  }

  /** Runs 30 days after the last activity: forget the room. */
  async alarm(): Promise<void> {
    if (this.state.getWebSockets().length === 0) {
      this.room = null;
      await this.state.storage.deleteAll();
    } else {
      await this.state.storage.setAlarm(Date.now() + KEEP_ROOM_MS);
    }
  }

  /** Returns true if the saved room data changed. */
  private handle(room: Room, ws: WS, msg: ClientMsg): boolean {
    if (msg.t === 'hello') {
      const { seat, token } = room.join(msg.name, msg.token);
      ws.serializeAttachment({ seat });
      this.send(ws, { t: 'welcome', seat, token });
      return true; // a new player may have taken a seat
    }

    const seat = this.seatOf(ws);
    if (seat === null) throw new RoomError('Join the table first.');

    switch (msg.t) {
      case 'start':
        room.start(seat);
        return true;
      case 'action':
        room.act(seat, msg.action);
        return true;
      case 'nextHand':
        room.nextHand();
        return true;
      case 'rematch':
        room.rematch();
        return true;
    }
  }

  private seatOf(ws: WS): number | null {
    const att = ws.deserializeAttachment() as { seat?: unknown } | null;
    return att && typeof att.seat === 'number' ? att.seat : null;
  }

  /** Send everyone their own personalised view. `closing` is a socket that is going away. */
  private broadcast(room: Room, closing?: WS): void {
    const sockets = this.state.getWebSockets().filter((s) => s !== closing);
    const connected: boolean[] = [];
    for (const s of sockets) {
      const seat = this.seatOf(s);
      if (seat !== null) connected[seat] = true;
    }
    const info = room.info(connected);
    for (const s of sockets) {
      const seat = this.seatOf(s);
      if (seat === null) continue;
      this.send(s, { t: 'update', you: seat, room: info, view: room.viewFor(seat) });
    }
  }

  private send(ws: WS, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket is already gone; the close handler will tidy up.
    }
  }

  private sendError(ws: WS, message: string): void {
    this.send(ws, { t: 'error', message });
  }
}
