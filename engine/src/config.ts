// Rule configuration. Everything that differs between published rule sets
// (and between the 2-player and 4-player games) lives here, so variants can
// be switched without touching the engine.

export interface RulesConfig {
  players: 2 | 4;
  /** Game ends when a side reaches this score at the end of a hand. */
  targetScore: number;
  /** Cards dealt to each player. */
  handSize: number;
  /** Cards drawn from the stock per turn. */
  drawCount: number;
  /** Canastas a side needs before a player may go out. */
  canastasToGoOut: number;
  naturalCanastaBonus: number;
  mixedCanastaBonus: number;
  redThreeBonus: number;
  /** Total for all four red threes (replaces 4 x redThreeBonus). */
  allRedThreesBonus: number;
  goOutBonus: number;
  concealedGoOutBonus: number;
}

export function defaultConfig(players: 2 | 4, overrides: Partial<RulesConfig> = {}): RulesConfig {
  const base: RulesConfig = {
    players,
    targetScore: 5000,
    handSize: players === 2 ? 15 : 11,
    drawCount: 1,
    canastasToGoOut: 1,
    naturalCanastaBonus: 500,
    mixedCanastaBonus: 300,
    redThreeBonus: 100,
    allRedThreesBonus: 800,
    goOutBonus: 100,
    concealedGoOutBonus: 200,
  };
  return { ...base, ...overrides };
}

/** Minimum card-point value of a side's initial meld, by its score before the hand. */
export function initialMeldMinimum(scoreBeforeHand: number): number {
  if (scoreBeforeHand < 0) return 15;
  if (scoreBeforeHand < 1500) return 50;
  if (scoreBeforeHand < 3000) return 90;
  if (scoreBeforeHand < 7000) return 120;
  return 150;
}

/** Which side (0 or 1) a player belongs to. 4 players: seats 0&2 vs 1&3. */
export function sideOf(config: RulesConfig, player: number): number {
  return config.players === 2 ? player : player % 2;
}

export function playersOfSide(config: RulesConfig, side: number): number[] {
  return config.players === 2 ? [side] : [side, side + 2];
}
