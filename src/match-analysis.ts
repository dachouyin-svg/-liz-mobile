import type { StoredPrediction } from "./storage";

export type OddsProvenance = {
  source: "API_FOOTBALL";
  status: "OK" | "PARTIAL" | "NO_MARKET" | "ERROR";
  retrievedAtUtc: string;
  providerUpdatedAtUtc: string | null;
  bookmakerCount: number;
  bookmakerNames: string[];
  pricingMethod: "CROSS_BOOKMAKER_MEDIAN";
  actionable: false;
  detail?: string;
};

export type NormalizedOddsInput = {
  oneXTwo?: { home: number; draw: number; away: number };
  overUnder25?: { over: number; under: number };
  btts?: { yes: number; no: number };
  provenance?: OddsProvenance;
};

export type ValueSelection = "HOME" | "DRAW" | "AWAY" | "OVER_2_5" | "UNDER_2_5" | "BTTS_YES" | "BTTS_NO";

export type ValueAssessment = {
  market: "1X2" | "OVER_UNDER_2_5" | "BTTS";
  selection: ValueSelection;
  decimalOdds: number;
  liz60Probability: number;
  liz61Probability: number;
  modelProbability: number;
  fairMarketProbability: number;
  edge: number;
  expectedValue: number;
  quarterKellyFraction: number;
  stakeUnits: 0;
  decision: "RESEARCH_SIGNAL" | "NO_BET";
  reason: string;
};

export type MatchAnalysis = {
  schema: "liz-match-analysis-v2";
  fixtureId: number;
  generatedAtUtc: string;
  model: "liz60_liz61";
  modelContract: "Liz6.0 Frozen + Liz6.1 MAIN / 90分钟 / results-only / strict-PIT";
  headline: string;
  sections: {
    modelBasis: string;
    outcome: string;
    goals: string;
    exactScores: string;
    totals: string;
    btts: string;
    modelAgreement: string;
    validationWarning: string;
    value: string;
    dataScope: string;
    disclaimer: string;
  };
  narrative: string;
  value: {
    decision: "RESEARCH_SIGNAL" | "NO_BET";
    bankrollUnits: number;
    assessments: ValueAssessment[];
    recommendations: ValueAssessment[];
    unavailableMarkets: string[];
    executionBlockedReasons: string[];
    validUntilUtc: string | null;
  };
};

const EDGE_GATE = 0.05;
const EV_GATE = 0.03;
const DEFAULT_BANKROLL_UNITS = 100;
const ODDS_TTL_MS = 10 * 60 * 1000;
const LABELS: Record<ValueSelection, string> = {
  HOME: "主胜", DRAW: "平局", AWAY: "客胜",
  OVER_2_5: "大于2.5球", UNDER_2_5: "小于2.5球",
  BTTS_YES: "双方进球", BTTS_NO: "至少一方不进球",
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Runtime guard for IndexedDB/backup records created outside the current build. */
export function isCurrentMatchAnalysis(value: unknown): value is MatchAnalysis {
  const root = objectRecord(value);
  if (!root || root.schema !== "liz-match-analysis-v2" || root.model !== "liz60_liz61") return false;
  if (!Number.isSafeInteger(root.fixtureId) || typeof root.generatedAtUtc !== "string" || !Number.isFinite(Date.parse(root.generatedAtUtc))) return false;
  if (typeof root.modelContract !== "string" || typeof root.headline !== "string" || typeof root.narrative !== "string") return false;
  const sections = objectRecord(root.sections);
  const sectionKeys = ["modelBasis", "outcome", "goals", "exactScores", "totals", "btts", "modelAgreement", "validationWarning", "value", "dataScope", "disclaimer"];
  if (!sections || !sectionKeys.every((key) => typeof sections[key] === "string")) return false;
  const result = objectRecord(root.value);
  if (!result || !["RESEARCH_SIGNAL", "NO_BET"].includes(String(result.decision)) || !finiteNumber(result.bankrollUnits) || (result.bankrollUnits as number) <= 0) return false;
  if (!Array.isArray(result.assessments) || !Array.isArray(result.recommendations) || !Array.isArray(result.unavailableMarkets) || !Array.isArray(result.executionBlockedReasons)) return false;
  if (!(result.validUntilUtc === null || (typeof result.validUntilUtc === "string" && Number.isFinite(Date.parse(result.validUntilUtc))))) return false;
  if (!(result.unavailableMarkets as unknown[]).every((item) => typeof item === "string") || !(result.executionBlockedReasons as unknown[]).every((item) => typeof item === "string")) return false;
  const assessmentValid = (item: unknown): boolean => {
    const row = objectRecord(item);
    if (!row
      || !["1X2", "OVER_UNDER_2_5", "BTTS"].includes(String(row.market))
      || !Object.keys(LABELS).includes(String(row.selection))
      || !["RESEARCH_SIGNAL", "NO_BET"].includes(String(row.decision))) return false;
    if (!["decimalOdds", "liz60Probability", "liz61Probability", "modelProbability", "fairMarketProbability", "edge", "expectedValue", "quarterKellyFraction", "stakeUnits"].every((key) => finiteNumber(row[key]))) return false;
    if ((row.decimalOdds as number) <= 1 || row.stakeUnits !== 0 || (row.quarterKellyFraction as number) < 0) return false;
    return ["liz60Probability", "liz61Probability", "modelProbability", "fairMarketProbability"]
      .every((key) => (row[key] as number) >= 0 && (row[key] as number) <= 1);
  };
  return (result.assessments as unknown[]).every(assessmentValid)
    && (result.recommendations as unknown[]).length <= 1
    && (result.recommendations as unknown[]).every((item) => {
      if (!assessmentValid(item)) return false;
      const row = item as Record<string, unknown>;
      return row.decision === "RESEARCH_SIGNAL" && row.stakeUnits === 0;
    });
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function validProbability(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("预测概率必须在 0 到 1 之间");
  return value;
}

function requireDistribution(values: readonly number[], label: string): void {
  values.forEach(validProbability);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-8) throw new RangeError(`${label} 概率之和必须为 1`);
}

function validOdds(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value) && value > 1);
}

/** Remove a bookmaker market's proportional overround. */
export function devigDecimalOdds(values: readonly number[]): number[] | null {
  if (values.length < 2 || !validOdds(values)) return null;
  const raw = values.map((value) => 1 / value);
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  return raw.map((value) => value / total);
}

function assess(
  market: ValueAssessment["market"],
  selection: ValueSelection,
  decimalOdds: number,
  liz60Probability: number,
  liz61Probability: number,
  fairMarketProbability: number,
): ValueAssessment {
  const p60 = validProbability(liz60Probability);
  const p61 = validProbability(liz61Probability);
  const probability = Math.min(p60, p61);
  const edge60 = p60 - fairMarketProbability;
  const edge61 = p61 - fairMarketProbability;
  const ev60 = p60 * decimalOdds - 1;
  const ev61 = p61 * decimalOdds - 1;
  const edge = Math.min(edge60, edge61);
  const expectedValue = Math.min(ev60, ev61);
  const fullKelly = Math.max(0, expectedValue / (decimalOdds - 1));
  const quarterKellyFraction = fullKelly / 4;
  const passes = edge60 + 1e-15 >= EDGE_GATE
    && edge61 + 1e-15 >= EDGE_GATE
    && ev60 + 1e-15 >= EV_GATE
    && ev61 + 1e-15 >= EV_GATE;
  return {
    market, selection, decimalOdds, liz60Probability: p60, liz61Probability: p61,
    modelProbability: probability, fairMarketProbability, edge, expectedValue,
    quarterKellyFraction, stakeUnits: 0,
    decision: passes ? "RESEARCH_SIGNAL" : "NO_BET",
    reason: passes
      ? `Liz6.0 与 Liz6.1 均通过：保守优势 ${pct(edge)}，保守期望值 ${pct(expectedValue)}`
      : "Liz6.0 与 Liz6.1 未同时达到优势5个百分点及期望值3%的研究门槛",
  };
}

function outcomeLabel(home: number, draw: number, away: number): string {
  const rows = [["主胜", home], ["平局", draw], ["客胜", away]] as const;
  return [...rows].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))[0][0];
}

function agreement(prediction: StoredPrediction): string {
  const ids = ["independent", "liz60", "liz61"] as const;
  const versions = ids.map((id) => prediction.versions[id]).filter(Boolean);
  if (versions.length !== 3) return "模型版本不完整，无法评价三模型一致性。";
  const favourites = versions.map((value) => outcomeLabel(value.homeWin, value.draw, value.awayWin));
  const spread = Math.max(
    ...(["homeWin", "draw", "awayWin"] as const).map((key) => {
      const values = versions.map((value) => value[key]);
      return Math.max(...values) - Math.min(...values);
    }),
  );
  return new Set(favourites).size === 1
    ? `独立泊松基线、Liz6.0 与 Liz6.1 都倾向${favourites[0]}，最大概率差为 ${pct(spread)}。`
    : `三个模型对最可能赛果存在分歧（${favourites.join(" / ")}），最大概率差为 ${pct(spread)}，应降低信心。`;
}

function validUntil(prediction: StoredPrediction, odds: NormalizedOddsInput): string | null {
  const retrieved = odds.provenance?.retrievedAtUtc;
  if (!retrieved || !Number.isFinite(Date.parse(retrieved))) return null;
  const expiry = Math.min(Date.parse(retrieved) + ODDS_TTL_MS, Date.parse(prediction.kickoffUtc));
  return Number.isFinite(expiry) ? new Date(expiry).toISOString() : null;
}

export function isAnalysisExpired(prediction: StoredPrediction, now = new Date()): boolean {
  if (!isCurrentMatchAnalysis(prediction.analysis)) return true;
  const limit = prediction.analysis.value.validUntilUtc;
  const limitTime = limit ? Date.parse(limit) : Number.NaN;
  const kickoffTime = Date.parse(prediction.kickoffUtc);
  return !Number.isFinite(limitTime) || !Number.isFinite(kickoffTime) || now.getTime() >= limitTime || now.getTime() >= kickoffTime;
}

export function analyzeMatch(
  prediction: StoredPrediction,
  odds: NormalizedOddsInput = {},
  options: { bankrollUnits?: number } = {},
): MatchAnalysis {
  const liz60 = prediction.versions.liz60;
  const liz61 = prediction.versions.liz61;
  if (!liz60 || !liz61) throw new RangeError("缺少 Liz6.0 冻结基线或 Liz6.1 主线预测");
  requireDistribution([liz60.homeWin, liz60.draw, liz60.awayWin], "Liz6.0 1X2");
  requireDistribution([liz61.homeWin, liz61.draw, liz61.awayWin], "Liz6.1 1X2");
  requireDistribution([liz60.over25, 1 - liz60.over25], "Liz6.0 大小球");
  requireDistribution([liz61.over25, 1 - liz61.over25], "Liz6.1 大小球");
  requireDistribution([liz60.bttsYes, 1 - liz60.bttsYes], "Liz6.0 双方进球");
  requireDistribution([liz61.bttsYes, 1 - liz61.bttsYes], "Liz6.1 双方进球");
  if (!Number.isFinite(prediction.homeLambda) || prediction.homeLambda <= 0 || !Number.isFinite(prediction.awayLambda) || prediction.awayLambda <= 0) {
    throw new RangeError("进球均值必须为正数");
  }
  const bankrollUnits = options.bankrollUnits ?? DEFAULT_BANKROLL_UNITS;
  if (!Number.isFinite(bankrollUnits) || bankrollUnits <= 0) throw new RangeError("资金单位必须为正数");

  const assessments: ValueAssessment[] = [];
  const unavailableMarkets: string[] = [];
  const addMarket = (
    market: ValueAssessment["market"],
    values: readonly number[] | undefined,
    probabilities60: readonly number[],
    probabilities61: readonly number[],
    selections: readonly ValueSelection[],
  ) => {
    if (!values) return;
    const fair = devigDecimalOdds(values);
    if (!fair) {
      unavailableMarkets.push(`${market} 赔率无效（每项必须是大于1的有限十进制赔率）`);
      return;
    }
    values.forEach((value, index) => assessments.push(assess(
      market, selections[index], value, probabilities60[index], probabilities61[index], fair[index],
    )));
  };

  addMarket("1X2", odds.oneXTwo && [odds.oneXTwo.home, odds.oneXTwo.draw, odds.oneXTwo.away],
    [liz60.homeWin, liz60.draw, liz60.awayWin], [liz61.homeWin, liz61.draw, liz61.awayWin], ["HOME", "DRAW", "AWAY"]);
  addMarket("OVER_UNDER_2_5", odds.overUnder25 && [odds.overUnder25.over, odds.overUnder25.under],
    [liz60.over25, 1 - liz60.over25], [liz61.over25, 1 - liz61.over25], ["OVER_2_5", "UNDER_2_5"]);
  addMarket("BTTS", odds.btts && [odds.btts.yes, odds.btts.no],
    [liz60.bttsYes, 1 - liz60.bttsYes], [liz61.bttsYes, 1 - liz61.bttsYes], ["BTTS_YES", "BTTS_NO"]);

  const retrievedAt = odds.provenance?.retrievedAtUtc ? Date.parse(odds.provenance.retrievedAtUtc) : Number.NaN;
  const kickoffAt = Date.parse(prediction.kickoffUtc);
  const sourceUsable = (odds.provenance?.status === "OK" || odds.provenance?.status === "PARTIAL")
    && odds.provenance.bookmakerCount > 0
    && Number.isFinite(retrievedAt)
    && Number.isFinite(kickoffAt)
    && retrievedAt < kickoffAt;
  const recommendations = sourceUsable
    ? assessments
      .filter((value) => value.decision === "RESEARCH_SIGNAL")
      .sort((left, right) => right.expectedValue - left.expectedValue)
      .slice(0, 1)
    : [];
  const top = [...(liz61.topScores ?? [])].slice(0, 3);
  const modelBasis = "依据 Liz6.1 MAIN 对手校正泊松模型，并用 Liz6.0 Frozen 冻结基线复核；严格按时间顺序只使用开球前已完成赛果，全部为90分钟口径。";
  const outcome = `Liz6.1 给出主胜 ${pct(liz61.homeWin)}、平局 ${pct(liz61.draw)}、客胜 ${pct(liz61.awayWin)}；当前最高方向为${outcomeLabel(liz61.homeWin, liz61.draw, liz61.awayWin)}。`;
  const goals = `主队进球均值 λ=${prediction.homeLambda.toFixed(2)}，客队 λ=${prediction.awayLambda.toFixed(2)}，合计 ${(prediction.homeLambda + prediction.awayLambda).toFixed(2)} 球。`;
  const exactScores = top.length
    ? `概率最高的比分为 ${top.map((item) => `${item.score}（${pct(item.probability)}）`).join("、")}。`
    : "暂无可用的精确比分排序。";
  const totals = `大于2.5球 ${pct(liz61.over25)}，小于2.5球 ${pct(1 - liz61.over25)}。`;
  const btts = `双方进球“是” ${pct(liz61.bttsYes)}，“否” ${pct(1 - liz61.bttsYes)}。`;
  const modelAgreement = agreement(prediction);
  const validationWarning = prediction.validationState === "SHADOW"
    ? "当前赛事处于观察阶段，输出只用于影子验证。"
    : prediction.validationState === "ALPHA"
      ? "当前赛事仍在测试阶段，历史赔率审计 G10 尚未通过。"
      : prediction.validationState === "RC"
        ? "当前赛事处于候选阶段，仍需完成运行观察与全部发布门槛。"
        : "当前赛事已进入正式阶段，但单场概率仍可能失误。";
  const suppliedOdds = Boolean(odds.oneXTwo || odds.overUnder25 || odds.btts);
  const value = recommendations.length
    ? `研究关注：${recommendations.map((item) => `${LABELS[item.selection]}（Liz6.0 ${pct(item.liz60Probability)} / Liz6.1 ${pct(item.liz61Probability)}）`).join("；")}。该信号来自跨公司中位参考价，不是可直接成交的投注指令。`
    : !suppliedOdds
      ? `不下注：${odds.provenance?.detail ?? "未取得可用实时赔率，无法判断投注价值"}。`
      : !sourceUsable || assessments.length === 0
        ? "不下注：赔率来源不完整或无效，无法判断投注价值。"
        : "不下注：现有参考赔率没有任何方向让 Liz6.0 与 Liz6.1 同时达到优势5个百分点及期望值3%的门槛。";
  const dataScope = "当前文字分析仅纳入历史赛果；球员名单、伤停、正式首发、天气、赛程动机和临场消息尚未进入模型。球员详情仅供查看。";
  const disclaimer = "本分析仅用于模型研究与风险教育，不构成投注、投资或盈利建议；赔率会变化，模型可能失误，请勿追损，并遵守所在地法律及负责任博彩原则。";
  const executionBlockedReasons = [
    ...(prediction.validationState !== "STABLE" ? ["赛事尚未通过正式阶段验证"] : []),
    ...(prediction.forecastState !== "T60_LOCKED" ? ["当前不是开球前60至70分钟锁定窗口"] : []),
    ...(!odds.provenance?.actionable ? ["当前为跨公司中位参考价，不是同一公司的可成交价"] : []),
    "历史赔率审计 G10 尚未通过",
  ];
  const sections = { modelBasis, outcome, goals, exactScores, totals, btts, modelAgreement, validationWarning, value, dataScope, disclaimer };
  return {
    schema: "liz-match-analysis-v2",
    fixtureId: prediction.fixtureId,
    generatedAtUtc: prediction.generatedAtUtc,
    model: "liz60_liz61",
    modelContract: "Liz6.0 Frozen + Liz6.1 MAIN / 90分钟 / results-only / strict-PIT",
    headline: `${prediction.home} 对阵 ${prediction.away}：${outcomeLabel(liz61.homeWin, liz61.draw, liz61.awayWin)}概率最高`,
    sections,
    narrative: Object.values(sections).join("\n\n"),
    value: {
      decision: recommendations.length ? "RESEARCH_SIGNAL" : "NO_BET",
      bankrollUnits,
      assessments,
      recommendations,
      unavailableMarkets,
      executionBlockedReasons,
      validUntilUtc: validUntil(prediction, odds),
    },
  };
}

export const analyseMatch = analyzeMatch;
