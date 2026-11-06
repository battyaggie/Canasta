// Stand-ins for the Cloudflare runtime objects, good enough to run the real GameRoom
// and Worker code in plain Node. Storage values go through structuredClone, like the
// real thing, so anything that isn't safely serialisable shows up as a test failure.

import type { ServerMsg } from '../../shared/protocol.js';

export class FakeWS {
  sent: string[] = [];
  closed = false;
  private attachment: unknown = null;

  send(data: string): void {
    if (this.closed) throw new Error('socket closed');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  messages(): ServerMsg[] {
    return this.sent.map((s) => JSON.parse(s) as ServerMsg);
  }
  last<T extends ServerMsg['t']>(type: T): Extract<ServerMsg, { t: T }> {
    const found = [...this.messages()].reverse().find((m) => m.t === type);
    if (!found) throw new Error(`no '${type}' message received; got ${this.sent.join(' | ')}`);
    return found as Extract<ServerMsg, { t: T }>;
  }
  clear(): void {
    this.sent = [];
  }
}

export class FakeState {
  store = new Map<string, unknown>();
  sockets: FakeWS[] = [];
  alarmAt: number | null = null;

  storage = {
    get: async <T>(key: string): Promise<T | undefined> => {
      const v = this.store.get(key);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    put: async (key: string, value: unknown): Promise<void> => {
      this.store.set(key, structuredClone(value));
    },
    deleteAll: async (): Promise<void> => {
      this.store.clear();
    },
    setAlarm: async (time: number): Promise<void> => {
      this.alarmAt = time;
    },
  };

  acceptWebSocket(ws: FakeWS): void {
    this.sockets.push(ws);
  }
  getWebSockets(): FakeWS[] {
    return this.sockets.filter((s) => !s.closed);
  }
}
