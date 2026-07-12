/**
 * Results-only opponent-adjusted Poisson GLM for Liz Mobile Cloud Alpha.
 *
 * Point-in-time policy: forecast at T-60m and assume a final result becomes
 * usable three hours after kickoff.  Therefore a source match is eligible
 * only when source kickoff + 3h <= target kickoff - 1h.
 */

export const FORECAST_LEAD_SECONDS = 60 * 60;
export const RESULT_BUFFER_SECONDS = 3 * 60 * 60;

export interface GlmFixture {
  fixtureId: number;
  timestamp: number;
  homeTeamId: number;
  awayTeamId: number;
  homeGoals90: number | null;
  awayGoals90: number | null;
}

export interface PoissonGlmConfig {
  halfLifeDays: number;
  /** Standard deviation of attack/defence effects; 0.20 means ridge 25. */
  teamEffectSd: number;
  lambdaMin: number;
  lambdaMax: number;
  maxIterations: number;
  gradientTolerance: number;
}

export type PoissonGlmConfigInput = Partial<PoissonGlmConfig>;

export const DEFAULT_POISSON_GLM_CONFIG: Readonly<PoissonGlmConfig> = {
  halfLifeDays: 365,
  teamEffectSd: 0.2,
  lambdaMin: 0.15,
  lambdaMax: 3.5,
  maxIterations: 100,
  gradientTolerance: 1e-6,
};

export interface GlmPrediction {
  homeLambda: number;
  awayLambda: number;
}

export interface PoissonGlmDiagnostics {
  objective: number;
  gradientInfNorm: number;
  iterations: number;
  eligibleFixtureCount: number;
  cutoffTimestamp: number;
  maximumAvailableAt: number;
  halfLifeDays: number;
  ridgePenalty: number;
}

export interface PoissonGlmFit {
  readonly cloudKernel: "Liz6.1 TypeScript Cloud Alpha";
  readonly converged: true;
  readonly cutoffTimestamp: number;
  readonly teamIds: readonly number[];
  readonly mu: number;
  readonly homeAdvantage: number;
  readonly attacks: readonly number[];
  readonly defenses: readonly number[];
  readonly eligibleFixtureCount: number;
  readonly maximumAvailableAt: number;
  readonly objective: number;
  readonly gradientInfNorm: number;
  readonly optimizerIterations: number;
  readonly config: Readonly<PoissonGlmConfig>;
  readonly diagnostics: Readonly<PoissonGlmDiagnostics>;
  predict(homeTeamId: number, awayTeamId: number): GlmPrediction;
}

export interface EligibleHistory {
  history: GlmFixture[];
  cutoffTimestamp: number;
}

function requireInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer`);
}

function validateFixture(row: GlmFixture): void {
  requireInteger(row.fixtureId, "fixtureId");
  requireInteger(row.timestamp, "timestamp");
  requireInteger(row.homeTeamId, "homeTeamId");
  requireInteger(row.awayTeamId, "awayTeamId");
  if (row.homeGoals90 !== null && (!Number.isSafeInteger(row.homeGoals90) || row.homeGoals90 < 0)) {
    throw new RangeError("homeGoals90 must be a non-negative integer or null");
  }
  if (row.awayGoals90 !== null && (!Number.isSafeInteger(row.awayGoals90) || row.awayGoals90 < 0)) {
    throw new RangeError("awayGoals90 must be a non-negative integer or null");
  }
}

function validatedConfig(input: PoissonGlmConfigInput = {}): PoissonGlmConfig {
  const config = { ...DEFAULT_POISSON_GLM_CONFIG, ...input };
  if (!Number.isFinite(config.halfLifeDays) || config.halfLifeDays <= 0) {
    throw new RangeError("halfLifeDays must be positive");
  }
  if (!Number.isFinite(config.teamEffectSd) || config.teamEffectSd <= 0) {
    throw new RangeError("teamEffectSd must be positive");
  }
  if (!Number.isFinite(config.lambdaMin) || !Number.isFinite(config.lambdaMax) ||
      config.lambdaMin <= 0 || config.lambdaMin >= config.lambdaMax) {
    throw new RangeError("invalid lambda gates");
  }
  if (!Number.isInteger(config.maxIterations) || config.maxIterations <= 0) {
    throw new RangeError("maxIterations must be a positive integer");
  }
  if (!Number.isFinite(config.gradientTolerance) || config.gradientTolerance <= 0) {
    throw new RangeError("gradientTolerance must be positive");
  }
  return config;
}

export function eligibleHistory(fixtures: readonly GlmFixture[], targetTimestamp: number): EligibleHistory {
  requireInteger(targetTimestamp, "targetTimestamp");
  const cutoffTimestamp = targetTimestamp - FORECAST_LEAD_SECONDS;
  const history: GlmFixture[] = [];
  for (const source of fixtures) {
    validateFixture(source);
    if (source.homeGoals90 === null || source.awayGoals90 === null) continue;
    const availableAt = source.timestamp + RESULT_BUFFER_SECONDS;
    if (availableAt <= cutoffTimestamp) history.push({ ...source });
  }
  history.sort(
    (left, right) =>
      left.timestamp + RESULT_BUFFER_SECONDS - (right.timestamp + RESULT_BUFFER_SECONDS) ||
      left.fixtureId - right.fixtureId,
  );
  return { history, cutoffTimestamp };
}

export interface GlmDesign {
  homeIndex: readonly number[];
  awayIndex: readonly number[];
  homeGoals: readonly number[];
  awayGoals: readonly number[];
  weights: readonly number[];
  ridge: number;
}

export interface ObjectiveGradient {
  objective: number;
  gradient: number[];
}

/** Exact penalized Poisson objective and analytic gradient. */
export function objectiveGradient(theta: readonly number[], design: GlmDesign): ObjectiveGradient {
  const teamCount = (theta.length - 2) / 2;
  if (!Number.isInteger(teamCount) || teamCount <= 0) throw new RangeError("invalid theta dimension");
  const rowCount = design.homeIndex.length;
  if (
    design.awayIndex.length !== rowCount ||
    design.homeGoals.length !== rowCount ||
    design.awayGoals.length !== rowCount ||
    design.weights.length !== rowCount
  ) {
    throw new RangeError("GLM design columns have different lengths");
  }
  const gradient = new Array<number>(theta.length).fill(0);
  let objective = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const home = design.homeIndex[row];
    const away = design.awayIndex[row];
    if (home < 0 || home >= teamCount || away < 0 || away >= teamCount) {
      throw new RangeError("team index outside theta dimension");
    }
    const etaHome = theta[0] + theta[1] + theta[2 + home] + theta[2 + teamCount + away];
    const etaAway = theta[0] + theta[2 + away] + theta[2 + teamCount + home];
    const lambdaHome = Math.exp(etaHome);
    const lambdaAway = Math.exp(etaAway);
    const weight = design.weights[row];
    const residualHome = weight * (lambdaHome - design.homeGoals[row]);
    const residualAway = weight * (lambdaAway - design.awayGoals[row]);
    objective += weight * (
      lambdaHome - design.homeGoals[row] * etaHome +
      lambdaAway - design.awayGoals[row] * etaAway
    );
    gradient[0] += residualHome + residualAway;
    gradient[1] += residualHome;
    gradient[2 + home] += residualHome;
    gradient[2 + away] += residualAway;
    gradient[2 + teamCount + away] += residualHome;
    gradient[2 + teamCount + home] += residualAway;
  }
  for (let index = 2; index < theta.length; index += 1) {
    objective += 0.5 * design.ridge * theta[index] * theta[index];
    gradient[index] += design.ridge * theta[index];
  }
  return { objective, gradient };
}

function addOuterProduct(hessian: number[][], indices: readonly number[], curvature: number): void {
  for (const row of indices) {
    for (const column of indices) hessian[row][column] += curvature;
  }
}

/** Exact dense Hessian used by the deterministic Newton solver. */
export function analyticHessian(theta: readonly number[], design: GlmDesign): number[][] {
  const teamCount = (theta.length - 2) / 2;
  if (!Number.isInteger(teamCount) || teamCount <= 0) throw new RangeError("invalid theta dimension");
  const dimension = theta.length;
  const hessian = Array.from({ length: dimension }, () => new Array<number>(dimension).fill(0));
  for (let row = 0; row < design.homeIndex.length; row += 1) {
    const home = design.homeIndex[row];
    const away = design.awayIndex[row];
    const etaHome = theta[0] + theta[1] + theta[2 + home] + theta[2 + teamCount + away];
    const etaAway = theta[0] + theta[2 + away] + theta[2 + teamCount + home];
    addOuterProduct(
      hessian,
      [0, 1, 2 + home, 2 + teamCount + away],
      design.weights[row] * Math.exp(etaHome),
    );
    addOuterProduct(
      hessian,
      [0, 2 + away, 2 + teamCount + home],
      design.weights[row] * Math.exp(etaAway),
    );
  }
  for (let index = 2; index < dimension; index += 1) hessian[index][index] += design.ridge;
  return hessian;
}

function infinityNorm(values: readonly number[]): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, Math.abs(value));
  return maximum;
}

/** Partial-pivot Gaussian elimination; does not mutate its arguments. */
function solveLinearSystem(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] {
  const dimension = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < dimension; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < dimension; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
    }
    if (!Number.isFinite(augmented[best][pivot]) || Math.abs(augmented[best][pivot]) < 1e-14) {
      throw new Error("Poisson GLM Hessian is singular");
    }
    [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
    const diagonal = augmented[pivot][pivot];
    for (let row = pivot + 1; row < dimension; row += 1) {
      const factor = augmented[row][pivot] / diagonal;
      if (factor === 0) continue;
      augmented[row][pivot] = 0;
      for (let column = pivot + 1; column <= dimension; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  const solution = new Array<number>(dimension).fill(0);
  for (let row = dimension - 1; row >= 0; row -= 1) {
    let value = augmented[row][dimension];
    for (let column = row + 1; column < dimension; column += 1) {
      value -= augmented[row][column] * solution[column];
    }
    solution[row] = value / augmented[row][row];
  }
  return solution;
}

export function fitPoissonGlm(
  fixtures: readonly GlmFixture[],
  targetTimestamp: number,
  targetTeamIds: readonly number[] = [],
  configInput: PoissonGlmConfigInput = {},
): PoissonGlmFit {
  const config = validatedConfig(configInput);
  const { history, cutoffTimestamp } = eligibleHistory(fixtures, targetTimestamp);
  if (history.length === 0) throw new Error("Poisson GLM requires eligible burn-in history");
  for (const teamId of targetTeamIds) requireInteger(teamId, "targetTeamId");
  const teamIds = [...new Set([
    ...history.flatMap((row) => [row.homeTeamId, row.awayTeamId]),
    ...targetTeamIds,
  ])].sort((left, right) => left - right);
  const lookup = new Map(teamIds.map((teamId, index) => [teamId, index]));
  const homeIndex = history.map((row) => lookup.get(row.homeTeamId)!);
  const awayIndex = history.map((row) => lookup.get(row.awayTeamId)!);
  const homeGoals = history.map((row) => row.homeGoals90!);
  const awayGoals = history.map((row) => row.awayGoals90!);
  const availableAt = history.map((row) => row.timestamp + RESULT_BUFFER_SECONDS);
  const ageDays = availableAt.map((timestamp) => (cutoffTimestamp - timestamp) / 86_400);
  if (ageDays.some((age) => age < 0)) throw new Error("negative PIT age detected");
  const weights = ageDays.map((age) => Math.pow(0.5, age / config.halfLifeDays));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const weightedHome = weights.reduce((sum, weight, index) => sum + weight * homeGoals[index], 0) / weightSum;
  const weightedAway = weights.reduce((sum, weight, index) => sum + weight * awayGoals[index], 0) / weightSum;
  const theta = new Array<number>(2 + 2 * teamIds.length).fill(0);
  theta[0] = Math.log(Math.max(weightedAway, 1e-12));
  theta[1] = Math.log(Math.max(weightedHome, 1e-12) / Math.max(weightedAway, 1e-12));
  const ridge = 1 / (config.teamEffectSd * config.teamEffectSd);
  const design: GlmDesign = { homeIndex, awayIndex, homeGoals, awayGoals, weights, ridge };

  let iterations = 0;
  let evaluation = objectiveGradient(theta, design);
  for (; iterations < config.maxIterations; iterations += 1) {
    const currentNorm = infinityNorm(evaluation.gradient);
    if (currentNorm <= config.gradientTolerance) break;
    const step = solveLinearSystem(analyticHessian(theta, design), evaluation.gradient);
    let stepScale = 1;
    let accepted = false;
    const objectiveSlack = Math.max(1e-12, Math.abs(evaluation.objective) * 1e-14);
    for (let lineSearch = 0; lineSearch < 40; lineSearch += 1) {
      const candidate = theta.map((value, index) => value - stepScale * step[index]);
      const candidateEvaluation = objectiveGradient(candidate, design);
      if (
        Number.isFinite(candidateEvaluation.objective) &&
        candidateEvaluation.objective <= evaluation.objective + objectiveSlack &&
        infinityNorm(candidateEvaluation.gradient) < currentNorm
      ) {
        theta.splice(0, theta.length, ...candidate);
        evaluation = candidateEvaluation;
        accepted = true;
        break;
      }
      stepScale *= 0.5;
    }
    if (!accepted) throw new Error("Poisson GLM Newton line search failed");
  }
  const gradientInfNorm = infinityNorm(evaluation.gradient);
  if (!Number.isFinite(evaluation.objective) || gradientInfNorm > config.gradientTolerance) {
    throw new Error(
      `Poisson GLM convergence gate failed: objective=${evaluation.objective}, gradient=${gradientInfNorm}`,
    );
  }
  const teamCount = teamIds.length;
  const attacks = theta.slice(2, 2 + teamCount);
  const defenses = theta.slice(2 + teamCount);
  const maximumAvailableAt = Math.max(...availableAt);
  const diagnostics: PoissonGlmDiagnostics = {
    objective: evaluation.objective,
    gradientInfNorm,
    iterations,
    eligibleFixtureCount: history.length,
    cutoffTimestamp,
    maximumAvailableAt,
    halfLifeDays: config.halfLifeDays,
    ridgePenalty: ridge,
  };
  const predict = (homeTeamId: number, awayTeamId: number): GlmPrediction => {
    requireInteger(homeTeamId, "homeTeamId");
    requireInteger(awayTeamId, "awayTeamId");
    const home = lookup.get(homeTeamId);
    const away = lookup.get(awayTeamId);
    const homeAttack = home === undefined ? 0 : attacks[home];
    const homeDefense = home === undefined ? 0 : defenses[home];
    const awayAttack = away === undefined ? 0 : attacks[away];
    const awayDefense = away === undefined ? 0 : defenses[away];
    const homeLambda = Math.exp(theta[0] + theta[1] + homeAttack + awayDefense);
    const awayLambda = Math.exp(theta[0] + awayAttack + homeDefense);
    if (homeLambda < config.lambdaMin || homeLambda > config.lambdaMax) {
      throw new RangeError(`home lambda outside release gate: ${homeLambda}`);
    }
    if (awayLambda < config.lambdaMin || awayLambda > config.lambdaMax) {
      throw new RangeError(`away lambda outside release gate: ${awayLambda}`);
    }
    return { homeLambda, awayLambda };
  };
  return {
    cloudKernel: "Liz6.1 TypeScript Cloud Alpha",
    converged: true,
    cutoffTimestamp,
    teamIds,
    mu: theta[0],
    homeAdvantage: theta[1],
    attacks,
    defenses,
    eligibleFixtureCount: history.length,
    maximumAvailableAt,
    objective: evaluation.objective,
    gradientInfNorm,
    optimizerIterations: iterations,
    config,
    diagnostics,
    predict,
  };
}

// Spelling aliases for code that uses Python's all-caps acronym.
export type PoissonGLMFit = PoissonGlmFit;
export const fitPoissonGLM = fitPoissonGlm;

