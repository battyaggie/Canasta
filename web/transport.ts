// Two ways to talk to a game room:
//   WsTransport    - a WebSocket to the Cloudflare Durable Object (online play, auto-reconnect)
//   LocalTransport - the same Room logic running right here in the page (pass & play on one device)
// The rest of the app doesn't care which one it has.

import type { ClientMsg, ServerMsg } from '../shared/protocol.js';
import { Room, RoomError, defaultDeps, type RoomData } from '../server/room.js';

const SAVE_KEY = 'canasta.local.save';

/** The unfinished pass & play game kept on this device, if any (a phone may reload the page at any moment). */
export function loadSavedLocal(): RoomData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as RoomData;
    return data?.game && data.phase === 'playing' ? data : null;
  } catch {
    return null;
  }
}

export function clearSavedLocal(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // storage may be blocked (private mode); nothing to clear
  }
}

export type Status = 'connecting' | 'open' | 'closed';

export interface Events {
  onMessage(msg: ServerMsg): void;
  onStatus(status: Status): void;
}

export interface Transport {
  send(msg: ClientMsg): void;
  close(): void;
}

export class WsTransport implements Transport {
  private ws: WebSocket | null = null;
  private closedByUs = false;
  private retry = 0;
  private timer: number | undefined;

  constructor(
    private code: string,
    private events: Events,
    private hello: () => ClientMsg,
  ) {
    this.connect();
  }

  private connect(): void {
    this.events.onStatus('connecting');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${location.host}/ws/${this.code}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.retry = 0;
      this.events.onStatus('open');
      ws.send(JSON.stringify(this.hello()));
    });
    ws.addEventListener('message', (e) => {
      try {
        this.events.onMessage(JSON.parse(String(e.data)) as ServerMsg);
      } catch {
        // ignore anything we can't read
      }
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.events.onStatus('closed');
      if (this.closedByUs) return;
      const delay = Math.min(10_000, 1000 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.connect(), delay);
    });
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.events.onMessage({ t: 'error', message: 'Not connected. Reconnecting…' });
  }

  close(): void {
    this.closedByUs = true;
    window.clearTimeout(this.timer);
    this.ws?.close();
  }
}

/** Pass & play: one device, everyone takes turns. The seat on screen is always the player whose turn it is. */
export class LocalTransport implements Transport {
  private room: Room;
  private viewSeat = 0;

  constructor(
    players: 2 | 4,
    private events: Events,
    saved?: RoomData | null,
  ) {
    // ?seed=123 makes the shuffles repeatable (used by the browser tests; harmless otherwise).
    let seed = Number(new URLSearchParams(location.search).get('seed'));
    const deps = Number.isInteger(seed) && seed > 0 ? { ...defaultDeps, randomSeed: () => seed++ } : undefined;
    // 'async' here only means "may look through the discard pile", which suits a shared screen.
    if (saved) {
      this.room = new Room(saved, deps ?? defaultDeps);
    } else {
      this.room = Room.create('LOCAL', { players, mode: 'async', targetScore: 5000 }, deps);
      for (let i = 0; i < players; i++) this.room.join(`Player ${i + 1}`, undefined);
      this.room.start(0);
    }
    this.save();
    this.viewSeat = this.room.data.game!.turn.player;
    setTimeout(() => {
      this.events.onStatus('open');
      this.events.onMessage({ t: 'welcome', seat: this.viewSeat, token: 'local' });
      this.emit();
    }, 0);
  }

  private save(): void {
    if (this.room.data.phase !== 'playing') return clearSavedLocal();
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.room.data));
    } catch {
      // storage full or blocked: the game still works, it just can't be resumed
    }
  }

  private emit(): void {
    const everyone = this.room.data.seats.map(() => true);
    this.events.onMessage({
      t: 'update',
      you: this.viewSeat,
      room: this.room.info(everyone),
      view: this.room.viewFor(this.viewSeat),
    });
  }

  send(msg: ClientMsg): void {
    try {
      if (msg.t === 'action') this.room.act(this.viewSeat, msg.action);
      else if (msg.t === 'nextHand') this.room.nextHand();
      else if (msg.t === 'rematch') this.room.rematch();
      else return;
      const game = this.room.data.game!;
      if (game.status === 'playing') this.viewSeat = game.turn.player;
      this.save();
      this.emit();
    } catch (e) {
      const message = e instanceof RoomError ? e.message : 'Something went wrong.';
      this.events.onMessage({ t: 'error', message });
    }
  }

  close(): void {}
}
