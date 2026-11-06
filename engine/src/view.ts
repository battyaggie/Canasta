import { type GameState, type HandResult, type SideState, type TurnState } from './engine.js';
import type { RulesConfig } from './config.js';

/**
 * What one player is allowed to see. Other players' hands and the stock are
 * reduced to counts, so the server can send this to a browser without leaking cards.
 * The discard pile, melds and red threes are public in Canasta.
 */
export interface PlayerView {
  config: RulesConfig;
  you: number;
  handNumber: number;
  dealer: number;
  myHand: number[];
  handSizes: number[];
  stockCount: number;
  pile: number[];
  pileFrozen: boolean;
  sides: [SideState, SideState];
  scores: [number, number];
  turn: TurnState;
  status: GameState['status'];
  handResult: HandResult | null;
  winner: number | null;
}

export function viewFor(state: GameState, player: number): PlayerView {
  return {
    config: state.config,
    you: player,
    handNumber: state.handNumber,
    dealer: state.dealer,
    myHand: [...(state.hands[player] ?? [])],
    handSizes: state.hands.map((h) => h.length),
    stockCount: state.stock.length,
    pile: [...state.pile],
    pileFrozen: state.pileFrozen,
    sides: structuredClone(state.sides),
    scores: [...state.scores],
    turn: { ...state.turn },
    status: state.status,
    handResult: state.handResult ? structuredClone(state.handResult) : null,
    winner: state.winner,
  };
}
