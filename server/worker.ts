// Cloudflare entry point.
//
//   POST /api/create        -> makes a room, returns { code }
//   GET  /api/room/:code    -> { settings, phase, seatsTaken } so the join page can fail early
//   GET  /ws/:code          -> WebSocket into that room's Durable Object
//   GET  /api/ice           -> { iceServers } for voice chat (STUN, plus TURN if a key is configured)
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
  /** Optional: a Cloudflare Realtime TURN key, for voice chat on networks that block direct calls. */
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
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

    if (path === '/api/ice' && request.method === 'GET') return json({ iceServers: await iceServers(env) });

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

// ---- voice chat: how browsers find a way to reach each other -----------------

const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

/**
 * STUN lets two browsers find each other's address, which is enough on most home and mobile networks.
 * Some networks block direct calls; for those a TURN relay passes the sound along. Cloudflare's TURN
 * service is used only if TURN_KEY_ID and TURN_KEY_API_TOKEN are set (wrangler secrets), and the
 * credentials it hands out expire after a day.
 */
async function iceServers(env: Env): Promise<unknown[]> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return STUN;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!res.ok) return STUN;
    const body = (await res.json()) as { iceServers?: unknown };
    const list = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
    return list.length ? list : STUN;
  } catch {
    return STUN;
  }
}

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
      const outcome = this.handle(room, ws, msg);
      if (outcome === 'save') await this.save();
      if (outcome !== 'none') this.broadcast(room);
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

  /** 'save': the saved room data changed; 'broadcast': only who-is-here changed; 'none': nothing to tell everyone. */
  private handle(room: Room, ws: WS, msg: ClientMsg): 'save' | 'broadcast' | 'none' {
    if (msg.t === 'hello') {
      const { seat, token } = room.join(msg.name, msg.token);
      ws.serializeAttachment({ seat, voice: false });
      this.send(ws, { t: 'welcome', seat, token });
      return 'save'; // a new player may have taken a seat
    }

    const seat = this.seatOf(ws);
    if (seat === null) throw new RoomError('Join the table first.');

    switch (msg.t) {
      case 'start':
        room.start(seat);
        return 'save';
      case 'action':
        room.act(seat, msg.action);
        return 'save';
      case 'nextHand':
        room.nextHand();
        return 'save';
      case 'rematch':
        room.rematch();
        return 'save';
      case 'voice':
        ws.serializeAttachment({ seat, voice: msg.on });
        return 'broadcast';
      case 'signal': {
        // Pass voice-call setup on to the other player, untouched. Only between seated players.
        if (msg.to === seat || !room.data.seats[msg.to]) throw new RoomError('That player is not at the table.');
        for (const s of this.state.getWebSockets()) {
          if (s !== ws && this.seatOf(s) === msg.to) this.send(s, { t: 'signal', from: seat, data: msg.data });
        }
        return 'none';
      }
    }
  }

  private seatOf(ws: WS): number | null {
    const att = ws.deserializeAttachment() as { seat?: unknown } | null;
    return att && typeof att.seat === 'number' ? att.seat : null;
  }

  private inVoice(ws: WS): boolean {
    const att = ws.deserializeAttachment() as { voice?: unknown } | null;
    return !!att && att.voice === true;
  }

  /** Send everyone their own personalised view. `closing` is a socket that is going away. */
  private broadcast(room: Room, closing?: WS): void {
    const sockets = this.state.getWebSockets().filter((s) => s !== closing);
    const connected: boolean[] = [];
    const voice: boolean[] = [];
    for (const s of sockets) {
      const seat = this.seatOf(s);
      if (seat !== null) connected[seat] = true;
      if (seat !== null && this.inVoice(s)) voice[seat] = true;
    }
    const info = room.info(connected, voice);
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
