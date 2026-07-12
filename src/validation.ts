import { predictScore, type ModelId } from "./liz-model";
import { eligibleHistory, fitPoissonGlm, type GlmFixture } from "./poisson-glm";
import type { LeagueProfile } from "./league-profiles";
import type { StoredFixture, SyncSnapshotMeta } from "./storage";

export type ValidationGateStatus = "PASS" | "FAIL" | "NOT_EVALUATED" | "BLOCKED";
export type ValidationOutcome = ValidationGateStatus;

const FORMAL_GATE_MANIFEST = "liz-formal-gates-v2-g10-blocked" as const;
const REQUIRED_GATE_IDS = [
  "identity", "score_completeness", "duplicates", "quarantine", "sample",
  "convergence", "pit", "lambda", "log_loss", "brier", "calibration", "G10",
] as const;

function requiredGateIds(profile: LeagueProfile): string[] {
  return profile.requiredType === "Cup" ? [...REQUIRED_GATE_IDS, "editions"] : [...REQUIRED_GATE_IDS];
}

export type ValidationProgress = {
  phase: "PREPARING" | "BACKTESTING" | "HASHING";
  processed: number;
  total: number;
  evaluated: number;
  skipped: number;
};

export type ValidationGate = {
  id: string;
  label: string;
  status: ValidationGateStatus;
  value: string;
  threshold: string;
  detail: string;
};

export type ValidationModelMetrics = {
  modelId: ModelId;
  label: string;
  evaluated: number;
  logLoss: number | null;
  brier: number | null;
  ece: number | null;
};

export type ValidationReport = {
  schema: "liz-validation-report-v2";
  gateManifest: typeof FORMAL_GATE_MANIFEST;
  appVersion: "6.1.0-rc.2";
  modelVersion: "6.1.0a4-cloud.1";
  generatedAtUtc: string;
  profile: {
    key: string;
    shortName: string;
    name: string;
    requiredType: "League" | "Cup";
    currentState: LeagueProfile["validationState"];
    expectedSeasons: number[];
  };
  outcome: ValidationOutcome;
  recommendation: "PROMOTE_RC" | "PROMOTE_ALPHA" | "PROMOTE_STABLE" | "HOLD";
  input: {
    fixtureCount: number;
    snapshotCount: number;
    completedInScopeCount: number;
    candidateTargetCount: number;
    evaluatedTargetCount: number;
    observedSeasons: number[];
    evaluatedSeasons: number[];
    latestSyncedAtUtc: string | null;
    datasetSha256: string;
  };
  diagnostics: {
    attemptedFits: number;
    convergedFits: number;
    convergenceRate: number | null;
    leakageViolations: number;
    lambdaViolations: number;
    fitFailures: number;
    duplicateFixtureIds: number;
    quarantineCount: number;
    scoreCompleteness: number | null;
  };
  models: Record<ModelId, ValidationModelMetrics>;
  gates: ValidationGate[];
  reportSha256: string;
};

export type FormalValidationInput = {
  profile: LeagueProfile;
  fixtures: readonly StoredFixture[];
  snapshots: readonly SyncSnapshotMeta[];
  generatedAt?: Date;
};

export type FormalValidationOptions = {
  onProgress?: (progress: ValidationProgress) => void;
  shouldCancel?: () => boolean;
  yieldEvery?: number;
};

export class ValidationCancelledError extends Error {
  constructor() { super("正式版验证已取消"); }
}

type MetricAccumulator = {
  evaluated: number;
  logLossSum: number;
  brierSum: number;
  bins: Array<{ count: number; probabilitySum: number; outcomeSum: number }>;
};

const MODEL_IDS: readonly ModelId[] = ["independent", "liz60", "liz61"];
const MODEL_LABELS: Record<ModelId, string> = {
  independent: "独立泊松基线",
  liz60: "Liz6.0 冻结基线",
  liz61: "Liz6.1 主线",
};
const ECE_BINS = 10;
const EPSILON = 1e-15;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Canonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sanitizedDataset(input: FormalValidationInput) {
  return {
    profileKey: input.profile.key,
    fixtures: [...input.fixtures]
      .sort((left, right) => left.fixtureId - right.fixtureId)
      .map((row) => ({
        fixtureId: row.fixtureId,
        profileKey: row.profileKey,
        season: row.season,
        kickoffUtc: row.kickoffUtc,
        timestamp: row.timestamp,
        statusShort: row.statusShort,
        round: row.round,
        scope: row.scope,
        homeTeamId: row.homeTeamId,
        awayTeamId: row.awayTeamId,
        homeGoals90: row.homeGoals90,
        awayGoals90: row.awayGoals90,
        syncedAtUtc: row.syncedAtUtc,
      })),
    snapshots: [...input.snapshots]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => ({
        id: row.id,
        profileKey: row.profileKey,
        season: row.season,
        capturedAtUtc: row.capturedAtUtc,
        providerLeagueId: row.providerLeagueId,
        providerName: row.providerName ?? null,
        providerCountry: row.providerCountry ?? null,
        fixtureCount: row.fixtureCount,
      })),
  };
}

export async function validationDatasetSha256(input: FormalValidationInput): Promise<string> {
  return sha256Canonical(sanitizedDataset(input));
}

function completedStatus(profile: LeagueProfile, status: string): boolean {
  return profile.requiredType === "Cup" ? ["FT", "AET", "PEN"].includes(status) : status === "FT";
}

function makeAccumulator(): MetricAccumulator {
  return {
    evaluated: 0,
    logLossSum: 0,
    brierSum: 0,
    bins: Array.from({ length: ECE_BINS }, () => ({ count: 0, probabilitySum: 0, outcomeSum: 0 })),
  };
}

function addMetrics(accumulator: MetricAccumulator, probabilities: readonly number[], actualIndex: number): void {
  const actualProbability = Math.max(EPSILON, Math.min(1, probabilities[actualIndex]));
  accumulator.evaluated += 1;
  accumulator.logLossSum += -Math.log(actualProbability);
  for (let index = 0; index < probabilities.length; index += 1) {
    const probability = Math.max(0, Math.min(1, probabilities[index]));
    const outcome = index === actualIndex ? 1 : 0;
    accumulator.brierSum += (probability - outcome) ** 2;
    const bin = accumulator.bins[Math.min(ECE_BINS - 1, Math.floor(probability * ECE_BINS))];
    bin.count += 1;
    bin.probabilitySum += probability;
    bin.outcomeSum += outcome;
  }
}

function finishMetrics(modelId: ModelId, accumulator: MetricAccumulator): ValidationModelMetrics {
  if (accumulator.evaluated === 0) {
    return { modelId, label: MODEL_LABELS[modelId], evaluated: 0, logLoss: null, brier: null, ece: null };
  }
  const calibrationSamples = accumulator.evaluated * 3;
  const ece = accumulator.bins.reduce((sum, bin) => {
    if (bin.count === 0) return sum;
    return sum + (bin.count / calibrationSamples) * Math.abs(
      bin.probabilitySum / bin.count - bin.outcomeSum / bin.count,
    );
  }, 0);
  return {
    modelId,
    label: MODEL_LABELS[modelId],
    evaluated: accumulator.evaluated,
    logLoss: accumulator.logLossSum / accumulator.evaluated,
    brier: accumulator.brierSum / accumulator.evaluated,
    ece,
  };
}

function gate(
  id: string,
  label: string,
  status: ValidationGateStatus,
  value: string,
  threshold: string,
  detail: string,
): ValidationGate {
  return { id, label, status, value, threshold, detail };
}

function identityGate(input: FormalValidationInput, fixtures: readonly StoredFixture[]): ValidationGate {
  if (input.snapshots.length === 0) {
    return gate("identity", "API 身份与赛季覆盖", "NOT_EVALUATED", "无同步快照", "全部配置赛季唯一解析", "请先运行完整历史同步。 ");
  }
  const missingSeasons: number[] = [];
  const ambiguousSeasons: number[] = [];
  const unnamedSeasons: number[] = [];
  const countMismatches: number[] = [];
  for (const season of input.profile.seasons) {
    const snapshots = input.snapshots.filter((row) => row.season === season);
    if (snapshots.length === 0) {
      missingSeasons.push(season);
      continue;
    }
    if (new Set(snapshots.map((row) => row.providerLeagueId)).size !== 1) ambiguousSeasons.push(season);
    const latest = [...snapshots].sort((left, right) => right.capturedAtUtc.localeCompare(left.capturedAtUtc))[0];
    if (!latest.providerName || !latest.providerCountry) unnamedSeasons.push(season);
    const storedCount = fixtures.filter((row) => row.season === season).length;
    if (storedCount !== latest.fixtureCount) countMismatches.push(season);
  }
  if (missingSeasons.length || ambiguousSeasons.length || countMismatches.length) {
    return gate(
      "identity",
      "API 身份与赛季覆盖",
      "FAIL",
      `缺失 ${missingSeasons.length} · 歧义 ${ambiguousSeasons.length} · 数量差异 ${countMismatches.length}`,
      "全部配置赛季唯一解析且数量一致",
      "重新运行完整历史同步；仍失败时保持当前验证状态。 ",
    );
  }
  if (unnamedSeasons.length) {
    return gate("identity", "API 身份与赛季覆盖", "NOT_EVALUATED", `${unnamedSeasons.length} 个旧版快照`, "快照含官方名称与国家", "重新同步以补齐新版身份清单。 ");
  }
  return gate("identity", "API 身份与赛季覆盖", "PASS", `${input.profile.seasons.length}/${input.profile.seasons.length} 赛季`, "全部配置赛季唯一解析", "官方赛事身份与本机赛季快照一致。 ");
}

function checkCancelled(options: FormalValidationOptions): void {
  if (options.shouldCancel?.()) throw new ValidationCancelledError();
}

async function cooperativeYield(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export async function runFormalValidation(
  input: FormalValidationInput,
  options: FormalValidationOptions = {},
): Promise<ValidationReport> {
  const fixtures = input.fixtures
    .filter((row) => row.profileKey === input.profile.key)
    .sort((left, right) => left.timestamp - right.timestamp || left.fixtureId - right.fixtureId);
  const completedInScope = fixtures.filter((row) =>
    row.scope === "IN_SCOPE" && row.homeGoals90 !== null && row.awayGoals90 !== null,
  );
  const completedProviderRows = fixtures.filter((row) => completedStatus(input.profile, row.statusShort));
  const scoreCompleteRows = completedProviderRows.filter((row) => row.homeGoals90 !== null && row.awayGoals90 !== null);
  const scoreCompleteness = completedProviderRows.length ? scoreCompleteRows.length / completedProviderRows.length : null;
  const duplicateFixtureIds = fixtures.length - new Set(fixtures.map((row) => row.fixtureId)).size;
  const quarantineCount = fixtures.filter((row) => row.scope === "QUARANTINE").length;
  const quarantineRate = fixtures.length ? quarantineCount / fixtures.length : null;
  const glmRows: GlmFixture[] = completedInScope.map((row) => ({
    fixtureId: row.fixtureId,
    timestamp: row.timestamp,
    homeTeamId: row.homeTeamId,
    awayTeamId: row.awayTeamId,
    homeGoals90: row.homeGoals90,
    awayGoals90: row.awayGoals90,
  }));
  const candidateTargets = completedInScope.filter((row) =>
    eligibleHistory(glmRows, row.timestamp).history.length >= input.profile.minHistory,
  );
  const requiredSample = input.profile.requiredType === "Cup" ? 100 : 300;
  const targets = candidateTargets.slice(-requiredSample);
  const latestSyncedAtUtc = input.snapshots.length
    ? [...input.snapshots].sort((left, right) => right.capturedAtUtc.localeCompare(left.capturedAtUtc))[0].capturedAtUtc
    : null;
  const progress: ValidationProgress = { phase: "PREPARING", processed: 0, total: targets.length, evaluated: 0, skipped: 0 };
  options.onProgress?.({ ...progress });
  checkCancelled(options);
  const datasetSha256 = await validationDatasetSha256({ ...input, fixtures });
  const accumulators: Record<ModelId, MetricAccumulator> = {
    independent: makeAccumulator(),
    liz60: makeAccumulator(),
    liz61: makeAccumulator(),
  };
  let attemptedFits = 0;
  let convergedFits = 0;
  let leakageViolations = 0;
  let lambdaViolations = 0;
  let fitFailures = 0;
  const evaluatedSeasons = new Set<number>();
  const yieldEvery = Math.max(1, options.yieldEvery ?? 5);
  progress.phase = "BACKTESTING";
  options.onProgress?.({ ...progress });

  for (let index = 0; index < targets.length; index += 1) {
    checkCancelled(options);
    const target = targets[index];
    attemptedFits += 1;
    try {
      const fit = fitPoissonGlm(glmRows, target.timestamp, [target.homeTeamId, target.awayTeamId]);
      convergedFits += 1;
      if (fit.diagnostics.maximumAvailableAt > fit.diagnostics.cutoffTimestamp) {
        leakageViolations += 1;
        progress.skipped += 1;
      } else {
        let lambdas: { homeLambda: number; awayLambda: number };
        try {
          lambdas = fit.predict(target.homeTeamId, target.awayTeamId);
        } catch {
          lambdaViolations += 1;
          progress.skipped += 1;
          progress.processed = index + 1;
          if (progress.processed === targets.length || progress.processed % yieldEvery === 0) {
            options.onProgress?.({ ...progress });
          }
          continue;
        }
        const actualIndex = (target.homeGoals90 as number) > (target.awayGoals90 as number)
          ? 0
          : (target.homeGoals90 as number) === (target.awayGoals90 as number) ? 1 : 2;
        for (const modelId of MODEL_IDS) {
          const prediction = predictScore(modelId, {
            homeLambda: lambdas.homeLambda,
            awayLambda: lambdas.awayLambda,
            balancedOpen: false,
            counterUnderdog: null,
            lowCreativity: null,
          });
          addMetrics(accumulators[modelId], [prediction.homeWin, prediction.draw, prediction.awayWin], actualIndex);
        }
        progress.evaluated += 1;
        evaluatedSeasons.add(target.season);
      }
    } catch {
      fitFailures += 1;
      progress.skipped += 1;
    }
    progress.processed = index + 1;
    if (progress.processed === targets.length || progress.processed % yieldEvery === 0) {
      options.onProgress?.({ ...progress });
    }
    if ((index + 1) % yieldEvery === 0) await cooperativeYield();
  }

  const models = Object.fromEntries(
    MODEL_IDS.map((modelId) => [modelId, finishMetrics(modelId, accumulators[modelId])]),
  ) as Record<ModelId, ValidationModelMetrics>;
  const gates: ValidationGate[] = [identityGate(input, fixtures)];
  gates.push(scoreCompleteness === null
    ? gate("score_completeness", "完赛比分完整率", "NOT_EVALUATED", "无完赛数据", "≥99.5%", "请先同步包含完赛比分的历史。 ")
    : gate("score_completeness", "完赛比分完整率", scoreCompleteness >= 0.995 ? "PASS" : "FAIL", `${(scoreCompleteness * 100).toFixed(2)}%`, "≥99.5%", "按赛事 90 分钟口径检查完赛比分。 "));
  gates.push(gate("duplicates", "重复比赛 ID", duplicateFixtureIds === 0 ? "PASS" : "FAIL", String(duplicateFixtureIds), "=0", "同一比赛只能出现一次。 "));
  gates.push(quarantineRate === null
    ? gate("quarantine", "未知轮次占比", "NOT_EVALUATED", "无赛程", "≤1%", "请先同步历史。 ")
    : gate("quarantine", "未知轮次占比", quarantineRate <= 0.01 ? "PASS" : "FAIL", `${(quarantineRate * 100).toFixed(2)}%`, "≤1%", "未知轮次必须先更新规则，不能进入训练。 "));
  gates.push(gate("sample", "样本外比赛数", progress.evaluated === 0 ? "NOT_EVALUATED" : progress.evaluated >= requiredSample ? "PASS" : "FAIL", String(progress.evaluated), `≥${requiredSample}`, input.profile.requiredType === "Cup" ? "杯赛采用最近 100 场严格滚动验证。 " : "联赛采用最近 300 场严格滚动验证。 "));
  if (input.profile.requiredType === "Cup") {
    gates.push(gate("editions", "样本外届次覆盖", progress.evaluated === 0 ? "NOT_EVALUATED" : evaluatedSeasons.size >= 2 ? "PASS" : "FAIL", String(evaluatedSeasons.size), "≥2", "稀疏杯赛至少覆盖两个届次。 "));
  }
  const convergenceRate = attemptedFits ? convergedFits / attemptedFits : null;
  gates.push(convergenceRate === null
    ? gate("convergence", "GLM 收敛率", "NOT_EVALUATED", "无可拟合比赛", "=100%", "历史烧入不足。 ")
    : gate("convergence", "GLM 收敛率", convergenceRate === 1 ? "PASS" : "FAIL", `${(convergenceRate * 100).toFixed(2)}%`, "=100%", `拟合失败 ${fitFailures} 次。 `));
  gates.push(gate("pit", "时间泄漏", attemptedFits === 0 ? "NOT_EVALUATED" : leakageViolations === 0 ? "PASS" : "FAIL", String(leakageViolations), "=0", "每场只使用 T−60 前已可用的赛果。 "));
  gates.push(gate("lambda", "λ 发布门槛越界", attemptedFits === 0 ? "NOT_EVALUATED" : lambdaViolations === 0 ? "PASS" : "FAIL", String(lambdaViolations), "=0", "任何越界都会阻断该场预测。 "));
  const liz61 = models.liz61;
  const independent = models.independent;
  const liz60 = models.liz60;
  const metricReady = liz61.logLoss !== null && independent.logLoss !== null && liz60.logLoss !== null && liz61.brier !== null && independent.brier !== null && liz60.brier !== null;
  gates.push(metricReady
    ? gate("log_loss", "Liz6.1 对数损失", (liz61.logLoss as number) <= (independent.logLoss as number) + 1e-12 && (liz61.logLoss as number) <= (liz60.logLoss as number) + 1e-12 ? "PASS" : "FAIL", (liz61.logLoss as number).toFixed(6), `≤ 独立基线 ${(independent.logLoss as number).toFixed(6)} 且 Liz6.0 ${(liz60.logLoss as number).toFixed(6)}`, "同一批样本上的胜平负对数损失。 ")
    : gate("log_loss", "Liz6.1 对数损失", "NOT_EVALUATED", "无结果", "不劣于两个基线", "没有足够的有效预测。 "));
  gates.push(metricReady
    ? gate("brier", "Liz6.1 布里尔分数", (liz61.brier as number) <= (independent.brier as number) + 1e-12 && (liz61.brier as number) <= (liz60.brier as number) + 1e-12 ? "PASS" : "FAIL", (liz61.brier as number).toFixed(6), `≤ 独立基线 ${(independent.brier as number).toFixed(6)} 且 Liz6.0 ${(liz60.brier as number).toFixed(6)}`, "三分类布里尔分数，越低越好。 ")
    : gate("brier", "Liz6.1 布里尔分数", "NOT_EVALUATED", "无结果", "不劣于两个基线", "没有足够的有效预测。 "));
  gates.push(liz61.ece === null
    ? gate("calibration", "Liz6.1 校准误差", "NOT_EVALUATED", "无结果", "≤0.04", "没有足够的有效预测。 ")
    : gate("calibration", "Liz6.1 校准误差", liz61.ece <= 0.04 ? "PASS" : "FAIL", liz61.ece.toFixed(6), "≤0.04", "按 10 个概率区间计算多分类校准误差。 "));

  gates.push(gate(
    "G10",
    "G10 历史赔率审计",
    "BLOCKED",
    "已阻断 · 无可信历史赔率输入",
    "2023–2024 共456场；胜平负与大小2.5各覆盖≥95%；同一博彩公司；收盘价为开球前至少5分钟的最后一次观测；去水概率和=1；全部样本外",
    "当前验证输入不含可审计的逐条历史赔率、博彩公司与观测时间；禁止用即时赔率或跨公司中位数伪造通过。G10 未通过不得正式发布。",
  ));

  const outcome: ValidationOutcome = gates.some((row) => row.status === "BLOCKED")
    ? "BLOCKED"
    : gates.some((row) => row.status === "FAIL") ? "FAIL"
    : gates.some((row) => row.status === "NOT_EVALUATED") ? "NOT_EVALUATED" : "PASS";
  progress.phase = "HASHING";
  options.onProgress?.({ ...progress });
  checkCancelled(options);
  const generatedAtUtc = (input.generatedAt ?? new Date()).toISOString();
  const reportWithoutHash = {
    schema: "liz-validation-report-v2" as const,
    gateManifest: FORMAL_GATE_MANIFEST,
    appVersion: "6.1.0-rc.2" as const,
    modelVersion: "6.1.0a4-cloud.1" as const,
    generatedAtUtc,
    profile: {
      key: input.profile.key,
      shortName: input.profile.shortName,
      name: input.profile.name,
      requiredType: input.profile.requiredType,
      currentState: input.profile.validationState,
      expectedSeasons: [...input.profile.seasons],
    },
    outcome,
    recommendation: outcome === "PASS"
      ? input.profile.validationState === "SHADOW"
        ? "PROMOTE_ALPHA" as const
        : input.profile.validationState === "ALPHA"
          ? "PROMOTE_RC" as const
          : input.profile.validationState === "RC" ? "PROMOTE_STABLE" as const : "HOLD" as const
      : "HOLD" as const,
    input: {
      fixtureCount: fixtures.length,
      snapshotCount: input.snapshots.length,
      completedInScopeCount: completedInScope.length,
      candidateTargetCount: candidateTargets.length,
      evaluatedTargetCount: progress.evaluated,
      observedSeasons: [...new Set(fixtures.map((row) => row.season))].sort((left, right) => left - right),
      evaluatedSeasons: [...evaluatedSeasons].sort((left, right) => left - right),
      latestSyncedAtUtc,
      datasetSha256,
    },
    diagnostics: {
      attemptedFits,
      convergedFits,
      convergenceRate,
      leakageViolations,
      lambdaViolations,
      fitFailures,
      duplicateFixtureIds,
      quarantineCount,
      scoreCompleteness,
    },
    models,
    gates,
  };
  const reportSha256 = await sha256Canonical(reportWithoutHash);
  return { ...reportWithoutHash, reportSha256 };
}

export async function reportMatchesInputs(
  report: ValidationReport,
  input: FormalValidationInput,
): Promise<boolean> {
  const g10 = Array.isArray(report.gates) ? report.gates.filter((row) => row.id === "G10") : [];
  const actualGateIds = Array.isArray(report.gates) ? report.gates.map((row) => row.id).sort() : [];
  const expectedGateIds = requiredGateIds(input.profile).sort();
  if (
    report.schema !== "liz-validation-report-v2" ||
    report.gateManifest !== FORMAL_GATE_MANIFEST ||
    report.appVersion !== "6.1.0-rc.2" ||
    report.modelVersion !== "6.1.0a4-cloud.1" ||
    !Array.isArray(report.gates) ||
    actualGateIds.length !== expectedGateIds.length ||
    actualGateIds.some((id, index) => id !== expectedGateIds[index]) ||
    g10.length !== 1 ||
    g10[0].status !== "BLOCKED" ||
    report.outcome !== "BLOCKED" ||
    report.recommendation !== "HOLD"
  ) return false;
  const { reportSha256, ...reportWithoutHash } = report;
  if (reportSha256 !== await sha256Canonical(reportWithoutHash)) return false;
  return report.profile.key === input.profile.key
    && report.profile.requiredType === input.profile.requiredType
    && report.input.datasetSha256 === await validationDatasetSha256(input);
}

export function sanitizeValidationReport(report: ValidationReport): ValidationReport {
  return JSON.parse(JSON.stringify(report)) as ValidationReport;
}
