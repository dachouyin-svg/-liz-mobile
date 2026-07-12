import assert from "node:assert/strict";
import test from "node:test";
import { analyzeMatch, devigDecimalOdds, isAnalysisExpired, isCurrentMatchAnalysis, type NormalizedOddsInput } from "../src/match-analysis";
import type { StoredPrediction } from "../src/storage";

function prediction(overrides: Partial<StoredPrediction> = {}): StoredPrediction {
  const version = {
    homeWin: 0.6, draw: 0.25, awayWin: 0.15, over25: 0.58, bttsYes: 0.55,
    topScores: [
      { score: "1-0", probability: 0.14 },
      { score: "2-0", probability: 0.11 },
      { score: "1-1", probability: 0.1 },
    ],
  };
  return {
    id: "1:2026-01-01", fixtureId: 1, profileKey: "kor_k_league_1",
    generatedAtUtc: "2026-01-01T00:00:00.000Z", kickoffUtc: "2026-01-02T00:00:00Z",
    home: "主队", away: "客队", forecastState: "PREVIEW", validationState: "ALPHA",
    homeLambda: 1.6, awayLambda: 0.9, eligibleFixtureCount: 300,
    versions: {
      independent: { ...version, homeWin: 0.57, draw: 0.26, awayWin: 0.17 },
      liz60: { ...version, homeWin: 0.59, draw: 0.25, awayWin: 0.16 },
      liz61: version,
    },
    ...overrides,
  };
}

function odds(markets: Omit<NormalizedOddsInput, "provenance">): NormalizedOddsInput {
  return {
    ...markets,
    provenance: {
      source: "API_FOOTBALL",
      status: "PARTIAL",
      retrievedAtUtc: "2026-01-01T12:00:00.000Z",
      providerUpdatedAtUtc: "2026-01-01T11:59:00.000Z",
      bookmakerCount: 2,
      bookmakerNames: ["甲公司", "乙公司"],
      pricingMethod: "CROSS_BOOKMAKER_MEDIAN",
      actionable: false,
    },
  };
}

test("de-vig normalizes a complete decimal-odds market", () => {
  const fair = devigDecimalOdds([2, 3, 4]);
  assert.ok(fair);
  assert.ok(Math.abs(fair.reduce((sum, value) => sum + value, 0) - 1) < 1e-15);
  assert.deepEqual(devigDecimalOdds([2, 1]), null);
  assert.deepEqual(devigDecimalOdds([2, Number.NaN]), null);
});

test("dual-model value gate emits only a non-actionable research signal", () => {
  const result = analyzeMatch(prediction(), odds({ oneXTwo: { home: 2.2, draw: 3.5, away: 4.2 } }), { bankrollUnits: 1_000 });
  const home = result.value.assessments.find((row) => row.selection === "HOME")!;
  assert.equal(home.decision, "RESEARCH_SIGNAL");
  assert.ok(home.edge >= 0.05);
  assert.ok(home.expectedValue >= 0.03);
  assert.equal(home.stakeUnits, 0, "G10 and executable price are unavailable, so stake must stay zero");
  assert.equal(result.value.decision, "RESEARCH_SIGNAL");
  assert.equal(result.value.recommendations.length, 1);
  assert.match(result.sections.value, /Liz6\.0.*Liz6\.1.*不是可直接成交/);

  const noValue = analyzeMatch(prediction(), odds({ oneXTwo: { home: 1.7, draw: 4, away: 6 } }));
  assert.equal(noValue.value.decision, "NO_BET");
  assert.match(noValue.sections.value, /^不下注/);
  assert.ok(noValue.value.assessments.every((row) => row.stakeUnits === 0));
});

test("a reference signal retains theoretical quarter Kelly but never exposes a stake", () => {
  const result = analyzeMatch(prediction(), odds({ oneXTwo: { home: 2.4, draw: 3.4, away: 4 } }), { bankrollUnits: 20 });
  const home = result.value.recommendations.find((row) => row.selection === "HOME")!;
  assert.ok(home);
  assert.ok(home.quarterKellyFraction > 0);
  assert.equal(home.stakeUnits, 0);
  assert.ok(result.value.executionBlockedReasons.some((reason) => /G10/.test(reason)));
});

test("invalid, partial, untraced, or post-kickoff markets never generate a signal", () => {
  const invalid = analyzeMatch(prediction(), odds({
    overUnder25: { over: 0, under: 1.9 },
    btts: { yes: Number.POSITIVE_INFINITY, no: 1.8 },
  }));
  assert.equal(invalid.value.decision, "NO_BET");
  assert.equal(invalid.value.assessments.length, 0);
  assert.equal(invalid.value.unavailableMarkets.length, 2);

  const untraced = analyzeMatch(prediction(), { oneXTwo: { home: 2.2, draw: 3.5, away: 4.2 } });
  assert.equal(untraced.value.decision, "NO_BET");
  const late = odds({ oneXTwo: { home: 2.2, draw: 3.5, away: 4.2 } });
  late.provenance!.retrievedAtUtc = "2026-01-02T00:01:00.000Z";
  assert.equal(analyzeMatch(prediction(), late).value.decision, "NO_BET");
});

test("deterministic Chinese narrative names the frozen and main model contracts", () => {
  const first = analyzeMatch(prediction());
  const second = analyzeMatch(prediction());
  assert.deepEqual(first, second);
  assert.equal(first.schema, "liz-match-analysis-v2");
  assert.match(first.sections.modelBasis, /Liz6\.1 MAIN.*Liz6\.0 Frozen.*90分钟/);
  assert.match(first.sections.outcome, /主胜.*平局.*客胜/);
  assert.match(first.sections.goals, /λ=.*合计/);
  assert.match(first.sections.exactScores, /1-0/);
  assert.match(first.sections.totals, /大于2\.5球.*小于2\.5球/);
  assert.match(first.sections.btts, /双方进球/);
  assert.match(first.sections.modelAgreement, /独立泊松基线.*Liz6\.0.*Liz6\.1/);
  assert.match(first.sections.validationWarning, /测试阶段.*G10/);
  assert.match(first.sections.dataScope, /伤停.*正式首发.*天气/);
  assert.match(first.sections.disclaimer, /不构成投注、投资或盈利建议/);
  assert.doesNotMatch(first.narrative, /保证盈利/);

  const shadow = analyzeMatch(prediction({ validationState: "SHADOW" }));
  assert.match(shadow.sections.validationWarning, /观察阶段/);
});

test("model disagreement is called out and invalid inputs fail closed", () => {
  const row = prediction();
  row.versions.independent = { ...row.versions.independent, homeWin: 0.2, draw: 0.25, awayWin: 0.55 };
  const result = analyzeMatch(row);
  assert.match(result.sections.modelAgreement, /存在分歧/);
  assert.throws(() => analyzeMatch(row, {}, { bankrollUnits: 0 }), /资金单位/);
  const broken = prediction();
  delete broken.versions.liz61;
  assert.throws(() => analyzeMatch(broken), /缺少 Liz6\.0.*Liz6\.1/);
  const brokenBaseline = prediction();
  delete brokenBaseline.versions.liz60;
  assert.throws(() => analyzeMatch(brokenBaseline), /缺少 Liz6\.0.*Liz6\.1/);
  const invalidDistribution = prediction();
  invalidDistribution.versions.liz60.homeWin = 0.8;
  assert.throws(() => analyzeMatch(invalidDistribution), /概率之和/);
});

test("stored research signals expire after ten minutes or at kickoff", () => {
  const row = prediction();
  const market = odds({ oneXTwo: { home: 2.2, draw: 3.5, away: 4.2 } });
  row.odds = market;
  row.analysis = analyzeMatch(row, market);
  assert.equal(isAnalysisExpired(row, new Date("2026-01-01T12:09:59.000Z")), false);
  assert.equal(isAnalysisExpired(row, new Date("2026-01-01T12:10:00.000Z")), true);
  assert.equal(isAnalysisExpired(row, new Date("2026-01-02T00:00:00.000Z")), true);

  const corrupted = { ...row.analysis, value: { ...row.analysis.value, validUntilUtc: "not-a-date" } };
  assert.equal(isCurrentMatchAnalysis(corrupted), false);
  row.analysis = corrupted as typeof row.analysis;
  assert.equal(isAnalysisExpired(row, new Date("2026-01-01T12:00:01.000Z")), true);
});
