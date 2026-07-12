/**
 * Liz score kernel for the mobile Cloud Alpha.
 *
 * This is a clean TypeScript port of the deterministic, analytic part of the
 * Python 6.1.0a4 kernel.  It intentionally does not claim byte-for-byte
 * identity with Python/NumPy/SciPy; parity is guarded with Python-generated
 * golden vectors in tests/model-parity.test.mjs.
 */

export type ModelId = "independent" | "liz60" | "liz61";
export type Side = "home" | "away";

export interface MatchInputs {
  homeLambda: number;
  awayLambda: number;
  balancedOpen?: boolean;
  counterUnderdog?: Side | null;
  lowCreativity?: Side | null;
}

export interface AdjustedMatchInputs {
  homeLambda: number;
  awayLambda: number;
  balancedOpen: boolean;
  counterUnderdog: Side | null;
  lowCreativity: Side | null;
}

export interface Regime {
  readonly name: "conservative" | "central" | "open";
  readonly weight: number;
  readonly goalMultiplier: number;
}

export interface ModelConfig {
  readonly id: ModelId;
  readonly label: string;
  readonly status: "baseline" | "frozen" | "alpha";
  readonly scoreScope: "90_minutes";
  readonly regimes: readonly Regime[];
  readonly rules: {
    readonly counterUnderdogLambdaFloor: number;
    readonly balancedOpenWeight: number | null;
    readonly lowCreativityLambdaMin: number;
    readonly lowCreativityLambdaMax: number;
  };
}

export interface RankedScore {
  home: number;
  away: number;
  score: string;
  probability: number;
}

export interface ScorePrediction {
  modelId: ModelId;
  modelLabel: string;
  /** Lambda values after all release gates; duplicated for simple API mapping. */
  homeLambda: number;
  awayLambda: number;
  adjustedInputs: AdjustedMatchInputs;
  scoreMatrix: number[][];
  homeMarginal: number[];
  awayMarginal: number[];
  totalMarginal: number[];
  homeWin: number;
  draw: number;
  awayWin: number;
  over25: number;
  under25: number;
  bttsYes: number;
  bttsNo: number;
  tailMass: number;
  topScores: RankedScore[];
}

const COMMON_RULES = {
  counterUnderdogLambdaFloor: 0.65,
  lowCreativityLambdaMin: 0.6,
  lowCreativityLambdaMax: 0.75,
} as const;

export const MODEL_CONFIGS: Readonly<Record<ModelId, ModelConfig>> = {
  independent: {
    id: "independent",
    label: "Independent Poisson Baseline",
    status: "baseline",
    scoreScope: "90_minutes",
    regimes: [{ name: "central", weight: 1, goalMultiplier: 1 }],
    rules: { ...COMMON_RULES, balancedOpenWeight: null },
  },
  liz60: {
    id: "liz60",
    label: "Liz6.0 Frozen",
    status: "frozen",
    scoreScope: "90_minutes",
    regimes: [
      { name: "conservative", weight: 0.3, goalMultiplier: 0.78 },
      { name: "central", weight: 0.4, goalMultiplier: 1 },
      { name: "open", weight: 0.3, goalMultiplier: 1.28 },
    ],
    // Python Liz6.0 exposes the allowed range (0.35, 0.40) rather than a
    // single switch value.  The frozen midpoint is the deterministic cloud
    // choice when balancedOpen is explicitly requested.
    rules: { ...COMMON_RULES, balancedOpenWeight: 0.375 },
  },
  liz61: {
    id: "liz61",
    label: "Liz6.1 MAIN / Cloud Alpha",
    status: "alpha",
    scoreScope: "90_minutes",
    regimes: [
      { name: "conservative", weight: 0.25, goalMultiplier: 0.78 },
      { name: "central", weight: 0.4, goalMultiplier: 1 },
      { name: "open", weight: 0.35, goalMultiplier: 1.28 },
    ],
    rules: { ...COMMON_RULES, balancedOpenWeight: 0.375 },
  },
};

function requireFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
}

function normalizeInputs(inputs: MatchInputs): AdjustedMatchInputs {
  requireFinitePositive(inputs.homeLambda, "homeLambda");
  requireFinitePositive(inputs.awayLambda, "awayLambda");
  const counterUnderdog = inputs.counterUnderdog ?? null;
  const lowCreativity = inputs.lowCreativity ?? null;
  if (counterUnderdog !== null && counterUnderdog !== "home" && counterUnderdog !== "away") {
    throw new RangeError("counterUnderdog must be home, away, or null");
  }
  if (lowCreativity !== null && lowCreativity !== "home" && lowCreativity !== "away") {
    throw new RangeError("lowCreativity must be home, away, or null");
  }
  return {
    homeLambda: inputs.homeLambda,
    awayLambda: inputs.awayLambda,
    balancedOpen: inputs.balancedOpen ?? false,
    counterUnderdog,
    lowCreativity,
  };
}

/** Apply Liz lambda gates while preserving the supplied total T exactly. */
export function adjustMatchInputs(modelId: ModelId, rawInputs: MatchInputs): AdjustedMatchInputs {
  const config = MODEL_CONFIGS[modelId];
  if (!config) throw new RangeError(`Unknown model: ${String(modelId)}`);
  const inputs = normalizeInputs(rawInputs);
  const total = inputs.homeLambda + inputs.awayLambda;
  let homeMin = 0;
  let awayMin = 0;
  let homeMax = Number.POSITIVE_INFINITY;
  let awayMax = Number.POSITIVE_INFINITY;

  if (inputs.lowCreativity === "home") {
    homeMin = config.rules.lowCreativityLambdaMin;
    homeMax = config.rules.lowCreativityLambdaMax;
  } else if (inputs.lowCreativity === "away") {
    awayMin = config.rules.lowCreativityLambdaMin;
    awayMax = config.rules.lowCreativityLambdaMax;
  }
  if (inputs.counterUnderdog === "home") {
    homeMin = Math.max(homeMin, config.rules.counterUnderdogLambdaFloor);
  } else if (inputs.counterUnderdog === "away") {
    awayMin = Math.max(awayMin, config.rules.counterUnderdogLambdaFloor);
  }

  const feasibleHomeMin = Math.max(homeMin, total - awayMax);
  const feasibleHomeMax = Math.min(homeMax, total - awayMin);
  if (feasibleHomeMin > feasibleHomeMax) {
    throw new RangeError("lambda rules are infeasible at the supplied total T");
  }
  const homeLambda = Math.min(Math.max(inputs.homeLambda, feasibleHomeMin), feasibleHomeMax);
  return { ...inputs, homeLambda, awayLambda: total - homeLambda };
}

function activeRegimes(config: ModelConfig, balancedOpen: boolean): Regime[] {
  const regimes = config.regimes.map((regime) => ({ ...regime }));
  if (!balancedOpen) return regimes;
  const target = config.rules.balancedOpenWeight;
  const openIndex = regimes.findIndex((regime) => regime.name === "open");
  if (target === null || openIndex < 0) {
    throw new RangeError("balancedOpen requires an open regime");
  }
  const otherTotal = 1 - regimes[openIndex].weight;
  if (otherTotal <= 0) throw new RangeError("cannot rebalance a 100% open configuration");
  const scale = (1 - target) / otherTotal;
  return regimes.map((regime, index) => ({
    ...regime,
    weight: index === openIndex ? target : regime.weight * scale,
  }));
}

function normalizedRegimes(config: ModelConfig, balancedOpen: boolean): Regime[] {
  const regimes = activeRegimes(config, balancedOpen);
  const meanMultiplier = regimes.reduce(
    (sum, regime) => sum + regime.weight * regime.goalMultiplier,
    0,
  );
  return regimes.map((regime) => ({
    ...regime,
    goalMultiplier: regime.goalMultiplier / meanMultiplier,
  }));
}

export function poissonPmf(rate: number, maxGoals: number): number[] {
  requireFinitePositive(rate, "rate");
  if (!Number.isInteger(maxGoals) || maxGoals < 0) {
    throw new RangeError("maxGoals must be a non-negative integer");
  }
  const values = new Array<number>(maxGoals + 1);
  values[0] = Math.exp(-rate);
  for (let goal = 1; goal <= maxGoals; goal += 1) {
    values[goal] = (values[goal - 1] * rate) / goal;
  }
  return values;
}

/** Full-support 1X2 for one independent-Poisson regime. */
function poissonOutcomes(homeRate: number, awayRate: number): [number, number, number] {
  // Lambda gates keep rates small, but derive the support dynamically so the
  // function remains numerically complete for direct library use too.
  const support = Math.max(80, Math.ceil(Math.max(homeRate, awayRate) + 18 * Math.sqrt(Math.max(homeRate, awayRate)) + 30));
  const home = poissonPmf(homeRate, support);
  const away = poissonPmf(awayRate, support);
  let awayCdfBefore = 0;
  let homeWin = 0;
  let draw = 0;
  for (let score = 0; score <= support; score += 1) {
    homeWin += home[score] * awayCdfBefore;
    draw += home[score] * away[score];
    awayCdfBefore += away[score];
  }
  // Defining the last orientation by complement makes the public 1X2 total
  // exactly one while the omitted double tail is far below double precision.
  return [homeWin, draw, Math.max(0, 1 - homeWin - draw)];
}

export function rankTopScores(scoreMatrix: readonly (readonly number[])[], limit = 10): RankedScore[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const ranked: RankedScore[] = [];
  for (let home = 0; home < scoreMatrix.length; home += 1) {
    for (let away = 0; away < scoreMatrix[home].length; away += 1) {
      ranked.push({ home, away, score: `${home}-${away}`, probability: scoreMatrix[home][away] });
    }
  }
  ranked.sort((left, right) => right.probability - left.probability || left.home - right.home || left.away - right.away);
  return ranked.slice(0, limit);
}

/**
 * Deterministic exact-score prediction (90 minutes only).
 * O/U is the 2.5 line and includes score-matrix tail mass in Over, matching
 * Python a4.  topScores defaults to ten entries from the visible matrix.
 */
export function predictScore(modelId: ModelId, inputs: MatchInputs, maxGoals = 12): ScorePrediction {
  if (!Number.isInteger(maxGoals) || maxGoals < 3) {
    throw new RangeError("maxGoals must be an integer of at least 3");
  }
  const config = MODEL_CONFIGS[modelId];
  if (!config) throw new RangeError(`Unknown model: ${String(modelId)}`);
  const adjustedInputs = adjustMatchInputs(modelId, inputs);
  const regimes = normalizedRegimes(config, adjustedInputs.balancedOpen);
  const dimension = maxGoals + 1;
  const scoreMatrix = Array.from({ length: dimension }, () => new Array<number>(dimension).fill(0));
  const homeMarginal = new Array<number>(dimension).fill(0);
  const awayMarginal = new Array<number>(dimension).fill(0);
  const totalMarginal = new Array<number>(maxGoals * 2 + 1).fill(0);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let bttsYes = 0;

  for (const regime of regimes) {
    const homeRate = adjustedInputs.homeLambda * regime.goalMultiplier;
    const awayRate = adjustedInputs.awayLambda * regime.goalMultiplier;
    const homePmf = poissonPmf(homeRate, maxGoals);
    const awayPmf = poissonPmf(awayRate, maxGoals);
    const totalPmf = poissonPmf(homeRate + awayRate, maxGoals * 2);
    for (let home = 0; home <= maxGoals; home += 1) {
      homeMarginal[home] += regime.weight * homePmf[home];
      for (let away = 0; away <= maxGoals; away += 1) {
        scoreMatrix[home][away] += regime.weight * homePmf[home] * awayPmf[away];
      }
    }
    for (let away = 0; away <= maxGoals; away += 1) {
      awayMarginal[away] += regime.weight * awayPmf[away];
    }
    for (let total = 0; total <= maxGoals * 2; total += 1) {
      totalMarginal[total] += regime.weight * totalPmf[total];
    }
    const [regimeHome, regimeDraw, regimeAway] = poissonOutcomes(homeRate, awayRate);
    homeWin += regime.weight * regimeHome;
    draw += regime.weight * regimeDraw;
    awayWin += regime.weight * regimeAway;
    bttsYes += regime.weight * (1 - Math.exp(-homeRate)) * (1 - Math.exp(-awayRate));
  }

  let captured = 0;
  let under25 = 0;
  for (let home = 0; home <= maxGoals; home += 1) {
    for (let away = 0; away <= maxGoals; away += 1) {
      const probability = scoreMatrix[home][away];
      captured += probability;
      if (home + away <= 2) under25 += probability;
    }
  }
  const tailMass = Math.max(0, 1 - captured);
  const over25 = 1 - under25;
  return {
    modelId,
    modelLabel: config.label,
    homeLambda: adjustedInputs.homeLambda,
    awayLambda: adjustedInputs.awayLambda,
    adjustedInputs,
    scoreMatrix,
    homeMarginal,
    awayMarginal,
    totalMarginal,
    homeWin,
    draw,
    awayWin,
    over25,
    under25,
    bttsYes,
    bttsNo: 1 - bttsYes,
    tailMass,
    topScores: rankTopScores(scoreMatrix, 10),
  };
}

// Friendly aliases for callers that describe the operation as prediction.
export const predictExactScore = predictScore;
