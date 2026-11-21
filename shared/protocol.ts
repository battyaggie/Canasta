// Messages exchanged between the browser and the game room.
// Everything that arrives from a browser is untrusted, so parseClientMsg()
// validates the exact shape before any of it reaches the rules engine.

import type { Action, MeldPlay, PlayerView } from '../engine/src/index.js';

export type Mode = 'live' | 'async';

export interface RoomSettings {
  players: 2 | 4;
  /** live: everyone is online; async: take your turn whenever, the game waits. */
  mode: Mode;
  targetScore: number;
  /** Seats played by the computer. Only used on one device (vs computer); online tables never set it. */
  bots?: number[];
  /** How well the computer plays. Default 'normal'. */
  botLevel?: 'easy' | 'normal';
}

export interface SeatInfo {
  name: string;
  connected: boolean;
}

export type Phase = 'lobby' | 'playing' | 'finished';

export interface RoomInfo {
  code: string;
  settings: RoomSettings;
  phase: Phase;
  /** One entry per seat; null while the seat is still empty. */
  seats: (SeatInfo | null)[];
  lastMoveAt: number | null;
}

export type ClientMsg =
  | { t: 'hello'; token?: string; name?: string }
  | { t: 'start' }
  | { t: 'action'; action: Action }
  | { t: 'nextHand' }
  | { t: 'rematch' };

export type ServerMsg =
  | { t: 'welcome'; seat: number; token: string }
  | { t: 'update'; you: number; room: RoomInfo; view: PlayerView | null }
  | { t: 'error'; message: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const MAX_MESSAGE_CHARS = 8000;
const MELD_RANKS = new Set(['A', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', '3']);

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCardId = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 108;

function parsePlays(raw: unknown): MeldPlay[] {
  if (!Array.isArray(raw) || raw.length > 14) throw new ProtocolError('Invalid melds');
  return raw.map((p) => {
    if (!isObject(p) || typeof p.rank !== 'string' || !MELD_RANKS.has(p.rank)) throw new ProtocolError('Invalid meld rank');
    if (!Array.isArray(p.cardIds) || p.cardIds.length > 30 || !p.cardIds.every(isCardId)) {
      throw new ProtocolError('Invalid meld cards');
    }
    return { rank: p.rank as MeldPlay['rank'], cardIds: [...(p.cardIds as number[])] };
  });
}

export function parseAction(raw: unknown): Action {
  if (!isObject(raw) || typeof raw.type !== 'string') throw new ProtocolError('Invalid action');
  switch (raw.type) {
    case 'drawStock':
      return { type: 'drawStock' };
    case 'skipDiscard':
      return { type: 'skipDiscard' };
    case 'discard':
      if (!isCardId(raw.cardId)) throw new ProtocolError('Invalid card');
      return { type: 'discard', cardId: raw.cardId };
    case 'meld':
      return { type: 'meld', melds: parsePlays(raw.melds) };
    case 'takePile':
      return { type: 'takePile', melds: parsePlays(raw.melds) };
    default:
      throw new ProtocolError('Unknown action');
  }
}

export function parseClientMsg(text: string): ClientMsg {
  if (text.length > MAX_MESSAGE_CHARS) throw new ProtocolError('Message too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolError('Not valid JSON');
  }
  if (!isObject(raw) || typeof raw.t !== 'string') throw new ProtocolError('Invalid message');
  switch (raw.t) {
    case 'hello': {
      const token = typeof raw.token === 'string' && raw.token.length <= 100 ? raw.token : undefined;
      const name = typeof raw.name === 'string' ? raw.name : undefined;
      return { t: 'hello', token, name };
    }
    case 'start':
      return { t: 'start' };
    case 'nextHand':
      return { t: 'nextHand' };
    case 'rematch':
      return { t: 'rematch' };
    case 'action':
      return { t: 'action', action: parseAction(raw.action) };
    default:
      throw new ProtocolError('Unknown message type');
  }
}

export function parseSettings(raw: unknown): RoomSettings {
  if (!isObject(raw)) throw new ProtocolError('Missing settings');
  const players = raw.players;
  if (players !== 2 && players !== 4) throw new ProtocolError('Players must be 2 or 4');
  const mode = raw.mode;
  if (mode !== 'live' && mode !== 'async') throw new ProtocolError('Mode must be live or async');
  let targetScore = 5000;
  if (raw.targetScore !== undefined) {
    if (!Number.isInteger(raw.targetScore) || (raw.targetScore as number) < 500 || (raw.targetScore as number) > 20000) {
      throw new ProtocolError('Target score must be between 500 and 20000');
    }
    targetScore = raw.targetScore as number;
  }
  return { players, mode, targetScore };
}
