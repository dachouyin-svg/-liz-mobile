import type { LeagueProfile } from "./league-profiles";
import { predictScore, type ModelId, type ScorePrediction } from "./liz-model";
import { eligibleHistory, fitPoissonGlm, type GlmFixture } from "./poisson-glm";
import type { StoredFixture, StoredPrediction } from "./storage";

const MODEL_IDS: readonly ModelId[] = ["independent", "liz60", "liz61"];
const LOCK_EARLIEST_SECONDS = 70 * 60;
const LOCK_LATEST_SECONDS = 60 * 60;

export function forecastStateFor(kickoffTimestamp: number, now: Date): StoredPrediction["forecastState"] {
  const secondsToKickoff = kickoffTimestamp - now.getTime() / 1000;
  return secondsToKickoff <= LOCK_EARLIEST_SECONDS && secondsToKickoff >= LOCK_LATEST_SECONDS
    ? "T60_LOCKED"
    : "PREVIEW";
}

function publicVersion(value: ScorePrediction): StoredPrediction["versions"][string] {
  return {
    homeWin: value.homeWin,
    draw: value.draw,
    awayWin: value.awayWin,
    over25: value.over25,
    bttsYes: value.bttsYes,
    topScores: value.topScores.slice(0, 10),
  };
}

/** Exact 6.1.0a4 Cloud Alpha score kernel and opponent-adjusted Poisson GLM. */
export function makePrediction(
  profile: LeagueProfile,
  target: StoredFixture,
  rows: readonly StoredFixture[],
  now = new Date(),
): StoredPrediction {
  if (target.scope !== "IN_SCOPE") throw new RangeError("该轮次未通过赛事范围门槛");
  if (target.statusShort !== "NS") throw new RangeError("只有未开赛（NS）的比赛可以预测");
  const secondsToKickoff = target.timestamp - now.getTime() / 1000;
  const minutesToKickoff = Math.floor(secondsToKickoff / 60);
  if (secondsToKickoff <= 0) throw new RangeError("比赛已经开始");

  const glmRows: GlmFixture[] = rows
    .filter((row) => row.scope === "IN_SCOPE")
    .map((row) => ({
      fixtureId: row.fixtureId,
      timestamp: row.timestamp,
      homeTeamId: row.homeTeamId,
      awayTeamId: row.awayTeamId,
      homeGoals90: row.homeGoals90,
      awayGoals90: row.awayGoals90,
    }));
  const targetTimestamp = target.timestamp;
  const eligibleCount = eligibleHistory(glmRows, targetTimestamp).history.length;
  if (eligibleCount < profile.minHistory) {
    throw new RangeError(`合格历史 ${eligibleCount} 场，至少需要 ${profile.minHistory} 场`);
  }
  const fit = fitPoissonGlm(glmRows, targetTimestamp, [target.homeTeamId, target.awayTeamId]);
  if (!fit.converged || fit.diagnostics.eligibleFixtureCount < profile.minHistory) {
    throw new RangeError(`合格历史 ${fit.diagnostics.eligibleFixtureCount} 场，至少需要 ${profile.minHistory} 场`);
  }
  if (fit.diagnostics.maximumAvailableAt > fit.diagnostics.cutoffTimestamp) {
    throw new RangeError("检测到时间泄漏，预测已阻断");
  }
  const lambdas = fit.predict(target.homeTeamId, target.awayTeamId);
  const modelInputs = {
    homeLambda: lambdas.homeLambda,
    awayLambda: lambdas.awayLambda,
    balancedOpen: false,
    counterUnderdog: null,
    lowCreativity: null,
  } as const;
  const versions = Object.fromEntries(
    MODEL_IDS.map((modelId) => [modelId, publicVersion(predictScore(modelId, modelInputs))]),
  ) as StoredPrediction["versions"];
  const generatedAtUtc = now.toISOString();
  return {
    id: `${target.fixtureId}:${generatedAtUtc}`,
    fixtureId: target.fixtureId,
    profileKey: profile.key,
    generatedAtUtc,
    kickoffUtc: target.kickoffUtc,
    home: target.homeTeamName,
    away: target.awayTeamName,
    forecastState: forecastStateFor(target.timestamp, now),
    validationState: profile.validationState,
    homeLambda: lambdas.homeLambda,
    awayLambda: lambdas.awayLambda,
    eligibleFixtureCount: fit.diagnostics.eligibleFixtureCount,
    versions,
  };
}
