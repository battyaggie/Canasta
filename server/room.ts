// The game room: who is sitting where, whose secret token is whose, and which
// actions are allowed. It is plain TypeScript with no server APIs in it, so the
// same code runs inside a Cloudflare Durable Object, in Node tests, and in the
// browser for pass-and-play on one device.
//
// Everything in RoomData is JSON-safe so the whole room can be saved and
// restored between moves.

import {
  type Action,
  type GameState,
  type PlayerView,
  IllegalMoveError,
  applyAction,
  defaultConfig,
  newGame,
  startNextHand,
  viewFor,
} from '../engine/src/index.js';
import type { Phase, RoomInfo, RoomSettings } from '../shared/protocol.js';

export class RoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomError';
  }
}

export interface RoomData {
  code: string;
  settings: RoomSettings;
  /** Seat i is seats[i]. Seats fill in order: 0, 1, 2, 3. */
  seats: { name: string; token: string }[];
  phase: Phase;
  game: GameState | null;
  lastMoveAt: number | null;
  createdAt: number;
}

export interface RoomDeps {
  now: () => number;
  /** Must return an unpredictable 31-bit integer. */
  randomSeed: () => number;
  /** Must return an unpredictable secret string. */
  randomToken: () => string;
}

export const defaultDeps: RoomDeps = {
  now: () => Date.now(),
  randomSeed: () => crypto.getRandomValues(new Uint32Array(1))[0]! >>> 1,
  randomToken: () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''),
};

const MAX_NAME = 20;

function cleanName(raw: string | undefined, seat: number): string {
  const name = (raw ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_NAME);
  return name || `Player ${seat + 1}`;
}

export class Room {
  constructor(
    public data: RoomData,
    private deps: RoomDeps = defaultDeps,
  ) {}

  static create(code: string, settings: RoomSettings, deps: RoomDeps = defaultDeps): Room {
    return new Room(
      { code, settings, seats: [], phase: 'lobby', game: null, lastMoveAt: null, createdAt: deps.now() },
      deps,
    );
  }

  /** Sit down at the table, or come back to your seat with the token you were given. */
  join(rawName: string | undefined, token: string | undefined): { seat: number; token: string } {
    if (token) {
      const seat = this.data.seats.findIndex((s) => s.token === token);
      if (seat >= 0) return { seat, token };
    }
    if (this.data.phase !== 'lobby') {
      throw new RoomError('This game has already started. Use your personal link on the device you first joined from.');
    }
    if (this.data.seats.length >= this.data.settings.players) throw new RoomError('This table is full.');
    const seat = this.data.seats.length;
    const newToken = this.deps.randomToken();
    this.data.seats.push({ name: cleanName(rawName, seat), token: newToken });
    return { seat, token: newToken };
  }

  start(seat: number): void {
    if (this.data.phase !== 'lobby') throw new RoomError('The game has already started.');
    if (seat !== 0) throw new RoomError('Only the host can start the game.');
    if (this.data.seats.length < this.data.settings.players) {
      throw new RoomError(`Waiting for ${this.data.settings.players - this.data.seats.length} more player(s).`);
    }
    this.newDeal();
  }

  private newDeal(): void {
    const cfg = defaultConfig(this.data.settings.players, { targetScore: this.data.settings.targetScore });
    this.data.game = newGame(cfg, this.deps.randomSeed());
    this.data.phase = 'playing';
    this.data.lastMoveAt = this.deps.now();
  }

  act(seat: number, action: Action): void {
    const game = this.requireGame();
    if (this.data.phase !== 'playing' || game.status !== 'playing') {
      throw new RoomError('There is no hand in progress.');
    }
    try {
      this.data.game = applyAction(game, seat, action);
    } catch (e) {
      if (e instanceof IllegalMoveError) throw new RoomError(e.message);
      throw new RoomError('That move could not be played.');
    }
    this.data.lastMoveAt = this.deps.now();
    if (this.data.game.status === 'gameOver') this.data.phase = 'finished';
  }

  /** Deal the next hand. Harmless if somebody else already did. */
  nextHand(): void {
    const game = this.requireGame();
    if (game.status !== 'handOver') return;
    this.data.game = startNextHand(game, this.deps.randomSeed());
    this.data.lastMoveAt = this.deps.now();
  }

  /** Start a fresh game with the same people. */
  rematch(): void {
    if (this.data.phase !== 'finished') return;
    this.newDeal();
  }

  private requireGame(): GameState {
    if (!this.data.game) throw new RoomError('The game has not started yet.');
    return this.data.game;
  }

  info(connected: boolean[], voice: boolean[] = []): RoomInfo {
    const seats: RoomInfo['seats'] = [];
    for (let i = 0; i < this.data.settings.players; i++) {
      const s = this.data.seats[i];
      seats.push(s ? { name: s.name, connected: connected[i] === true, ...(voice[i] ? { voice: true } : {}) } : null);
    }
    return {
      code: this.data.code,
      settings: this.data.settings,
      phase: this.data.phase,
      seats,
      lastMoveAt: this.data.lastMoveAt,
    };
  }

  /**
   * What this seat may see. At a live table only the top card of the discard pile is visible, as
   * at a real table: the cards beneath it are replaced by -1 (the count is kept). Take-turns tables
   * and pass & play may look through the pile, since remembering it over days is hard.
   */
  viewFor(seat: number): PlayerView | null {
    if (!this.data.game) return null;
    const view = viewFor(this.data.game, seat);
    if (this.data.settings.mode === 'live') {
      view.pile = view.pile.map((id, i, all) => (i === all.length - 1 ? id : -1));
    }
    return view;
  }
}
