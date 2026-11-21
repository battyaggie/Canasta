// The Cloudflare runtime, faked just enough for browser tests: Playwright intercepts /api/* and
// WebSocket connections and hands them to the REAL worker.fetch() / GameRoom code running in Node.
import worker, { GameRoom } from '../../server/worker.js';
import { FakeState } from '../../server/test/fakes.js';

/** A browser WebSocket seen from the Durable Object's side. */
class BridgeSocket {
  closed = false;
  private attachment: unknown = null;
  constructor(private route: any) {}
  send(data: string) {
    if (this.closed) throw new Error('closed');
    this.route.send(data);
  }
  close() {
    this.closed = true;
    this.route.close();
  }
  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
}

export class CloudflareSim {
  rooms = new Map<string, { state: FakeState; room: GameRoom }>();

  private entry(code: string) {
    let e = this.rooms.get(code);
    if (!e) {
      const state = new FakeState();
      e = { state, room: new GameRoom(state as never, {} as never) };
      this.rooms.set(code, e);
    }
    return e;
  }

  env = {
    ROOMS: {
      idFromName: (n: string) => n,
      get: (id: unknown) => ({ fetch: (i: string | Request, init?: RequestInit) => this.entry(String(id)).room.fetch(new Request(i, init)) }),
    },
    ASSETS: { fetch: async () => new Response('asset') },
  };

  async attach(context: any) {
    await context.route(/\/api\//, async (route: any) => {
      const req = route.request();
      const body = req.postData() ?? undefined;
      const res = await worker.fetch(
        new Request(req.url(), { method: req.method(), body, headers: body ? { 'content-type': 'application/json' } : {} }),
        this.env as never,
      );
      await route.fulfill({ status: res.status, headers: { 'content-type': 'application/json' }, body: await res.text() });
    });
    await context.routeWebSocket(/\/ws\//, (ws: any) => {
      const code = new URL(ws.url()).pathname.split('/').pop()!.toUpperCase();
      const { state, room } = this.entry(code);
      const sock = new BridgeSocket(ws);
      state.acceptWebSocket(sock as never);
      ws.onMessage((m: string | Buffer) => void room.webSocketMessage(sock as never, String(m)));
      ws.onClose(() => {
        sock.closed = true;
        void room.webSocketClose(sock as never);
      });
    });
  }
}

