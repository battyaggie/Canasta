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

/** How a player appears at the 3D table, as they chose it themselves. */
export type Figure = 'man' | 'woman';

export interface SeatInfo {
  name: string;
  figure?: Figure;
  connected: boolean;
  /** This player has joined the voice chat (their microphone is on, or muted but listening). */
  voice?: boolean;
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

/**
 * Voice chat setup, passed between two browsers through the room (the sound itself goes directly
 * between the browsers, never through the server). `s` is the sender's id for this call attempt and
 * `r` the id it is replying to, so leftovers from an earlier attempt can be told apart.
 */
export type SignalData =
  | { s: string; r?: string; sdp: { type: 'offer' | 'answer'; sdp: string } }
  | { s: string; r?: string; ice: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null };

export type ClientMsg =
  | { t: 'hello'; token?: string; name?: string; figure?: Figure }
  | { t: 'start' }
  | { t: 'action'; action: Action }
  | { t: 'nextHand' }
  | { t: 'rematch' }
  | { t: 'voice'; on: boolean }
  | { t: 'signal'; to: number; data: SignalData };

export type ServerMsg =
  | { t: 'welcome'; seat: number; token: string }
  | { t: 'update'; you: number; room: RoomInfo; view: PlayerView | null }
  | { t: 'signal'; from: number; data: SignalData }
  | { t: 'error'; message: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const MAX_MESSAGE_CHARS = 16000;
const MAX_SDP_CHARS = 14000;
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

function parseSignal(raw: unknown): SignalData {
  if (!isObject(raw) || typeof raw.s !== 'string' || raw.s.length < 1 || raw.s.length > 40) throw new ProtocolError('Invalid signal');
  const s = raw.s;
  if (raw.r !== undefined && (typeof raw.r !== 'string' || raw.r.length > 40)) throw new ProtocolError('Invalid signal');
  const r = raw.r === undefined ? {} : { r: raw.r as string };
  if ('sdp' in raw) {
    const sdp = raw.sdp;
    if (!isObject(sdp) || (sdp.type !== 'offer' && sdp.type !== 'answer') || typeof sdp.sdp !== 'string' || sdp.sdp.length > MAX_SDP_CHARS) {
      throw new ProtocolError('Invalid signal');
    }
    return { s, ...r, sdp: { type: sdp.type, sdp: sdp.sdp } };
  }
  if ('ice' in raw) {
    const ice = raw.ice;
    if (ice === null) return { s, ...r, ice: null };
    if (!isObject(ice) || typeof ice.candidate !== 'string' || ice.candidate.length > 1000) throw new ProtocolError('Invalid signal');
    const sdpMid = typeof ice.sdpMid === 'string' && ice.sdpMid.length <= 40 ? ice.sdpMid : null;
    const sdpMLineIndex = Number.isInteger(ice.sdpMLineIndex) && (ice.sdpMLineIndex as number) >= 0 && (ice.sdpMLineIndex as number) < 16 ? (ice.sdpMLineIndex as number) : null;
    return { s, ...r, ice: { candidate: ice.candidate, sdpMid, sdpMLineIndex } };
  }
  throw new ProtocolError('Invalid signal');
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
      const figure = raw.figure === 'man' || raw.figure === 'woman' ? raw.figure : undefined;
      return { t: 'hello', token, name, ...(figure ? { figure } : {}) };
    }
    case 'start':
      return { t: 'start' };
    case 'nextHand':
      return { t: 'nextHand' };
    case 'rematch':
      return { t: 'rematch' };
    case 'action':
      return { t: 'action', action: parseAction(raw.action) };
    case 'voice':
      if (typeof raw.on !== 'boolean') throw new ProtocolError('Invalid voice message');
      return { t: 'voice', on: raw.on };
    case 'signal':
      if (!Number.isInteger(raw.to) || (raw.to as number) < 0 || (raw.to as number) > 3) throw new ProtocolError('Invalid seat');
      return { t: 'signal', to: raw.to as number, data: parseSignal(raw.data) };
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
