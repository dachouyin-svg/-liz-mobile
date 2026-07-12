import assert from "node:assert/strict";
import test from "node:test";
import { isStoredFixtureRecord, isStoredPredictionRecord, parseLizBackup, type LizBackup, type StoredFixture, type StoredPrediction, type SyncSnapshot } from "../src/storage";

const fixture: StoredFixture = {
  fixtureId: 1,
  profileKey: "kor_k_league_1",
  season: 2026,
  kickoffUtc: "2026-07-18T10:30:00.000Z",
  timestamp: 1_784_370_600,
  statusShort: "NS",
  round: "Regular Season - 20",
  scope: "IN_SCOPE",
  homeTeamId: 10,
  awayTeamId: 20,
  homeTeamName: "主队",
  awayTeamName: "客队",
  homeGoals90: null,
  awayGoals90: null,
  syncedAtUtc: "2026-07-13T00:00:00.000Z",
};

const version = {
  homeWin: 0.5,
  draw: 0.3,
  awayWin: 0.2,
  over25: 0.48,
  bttsYes: 0.51,
  topScores: [{ score: "1-0", probability: 0.12 }],
};

const prediction: StoredPrediction = {
  id: "1:2026-07-13T00:00:00.000Z",
  fixtureId: 1,
  profileKey: "kor_k_league_1",
  generatedAtUtc: "2026-07-13T00:00:00.000Z",
  kickoffUtc: "2026-07-18T10:30:00.000Z",
  home: "主队",
  away: "客队",
  forecastState: "PREVIEW",
  validationState: "ALPHA",
  homeLambda: 1.4,
  awayLambda: 1.1,
  eligibleFixtureCount: 300,
  versions: { independent: version, liz60: version, liz61: version },
};

const snapshot: SyncSnapshot = {
  id: "kor_k_league_1:2026:1",
  profileKey: "kor_k_league_1",
  season: 2026,
  capturedAtUtc: "2026-07-13T00:00:00.000Z",
  providerLeagueId: 292,
  providerName: "K League 1",
  providerCountry: "South-Korea",
  fixtureCount: 228,
  payload: { response: [] },
};

function backup(overrides: Partial<LizBackup> = {}): LizBackup {
  return {
    schema: "liz-mobile-backup-v1",
    exportedAtUtc: "2026-07-13T01:00:00.000Z",
    fixtures: [fixture],
    predictions: [prediction],
    snapshots: [snapshot],
    ...overrides,
  };
}

test("valid backup contracts are accepted before any IndexedDB write", () => {
  assert.equal(isStoredFixtureRecord(fixture), true);
  assert.equal(isStoredPredictionRecord(prediction), true);
  const result = parseLizBackup(backup());
  assert.equal(result.fixtures.length, 1);
  assert.equal(result.predictions.length, 1);
  assert.equal(result.snapshots.length, 1);
});

test("invalid prediction date and invalid fixture round reject the entire backup", () => {
  const invalidPrediction = { ...prediction, generatedAtUtc: 123 } as unknown as StoredPrediction;
  assert.equal(isStoredPredictionRecord(invalidPrediction), false);
  assert.throws(() => parseLizBackup(backup({ predictions: [invalidPrediction] })), /无效预测.*未导入任何数据/);

  const invalidFixture = { ...fixture, round: 99 } as unknown as StoredFixture;
  assert.equal(isStoredFixtureRecord(invalidFixture), false);
  assert.throws(() => parseLizBackup(backup({ fixtures: [invalidFixture] })), /无效赛程.*未导入任何数据/);
});

test("duplicate keys and forged current analysis fail closed; legacy analysis is removed", () => {
  assert.throws(() => parseLizBackup(backup({ fixtures: [fixture, { ...fixture }] })), /重复的比赛编号/);

  const forged = {
    ...prediction,
    analysis: { schema: "liz-match-analysis-v2", fixtureId: 1 },
  } as unknown as StoredPrediction;
  assert.throws(() => parseLizBackup(backup({ predictions: [forged] })), /损坏的文字分析/);

  const legacy = {
    ...prediction,
    analysis: { schema: "liz-match-analysis-v1", headline: "旧版" },
  } as unknown as StoredPrediction;
  const migrated = parseLizBackup(backup({ predictions: [legacy] }));
  assert.equal(migrated.predictions[0].analysis, undefined);
});
