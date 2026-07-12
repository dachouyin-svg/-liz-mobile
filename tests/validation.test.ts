import assert from "node:assert/strict";
import test from "node:test";
import { getLeagueProfile } from "../src/league-profiles";
import type { StoredFixture, SyncSnapshotMeta } from "../src/storage";
import {
  reportMatchesInputs,
  runFormalValidation,
  sha256Canonical,
  ValidationCancelledError,
  type ValidationReport,
} from "../src/validation";

const profile = getLeagueProfile("kor_k_league_1");

function syntheticFixtures(count = 420): StoredFixture[] {
  const homeGoals = [1, 2, 1, 0, 2, 1, 3, 0, 1, 2];
  const awayGoals = [0, 1, 1, 2, 0, 1, 1, 0, 2, 1];
  return Array.from({ length: count }, (_, index) => {
    const season = 2021 + Math.min(5, Math.floor(index / 70));
    return {
      fixtureId: 10_000 + index,
      profileKey: profile.key,
      season,
      kickoffUtc: new Date((1_609_459_200 + index * 172_800) * 1000).toISOString(),
      timestamp: 1_609_459_200 + index * 172_800,
      statusShort: "FT",
      round: `Regular Season - ${(index % 38) + 1}`,
      scope: "IN_SCOPE",
      homeTeamId: 1 + (index % 6),
      awayTeamId: 1 + ((index + 1 + Math.floor(index / 6)) % 6),
      homeTeamName: `Home ${index}`,
      awayTeamName: `Away ${index}`,
      homeGoals90: homeGoals[index % homeGoals.length],
      awayGoals90: awayGoals[index % awayGoals.length],
      syncedAtUtc: "2026-07-13T00:00:00.000Z",
    };
  });
}

function snapshotMeta(fixtures: StoredFixture[]): SyncSnapshotMeta[] {
  return profile.seasons.map((season) => ({
    id: `${profile.key}:${season}:test`,
    profileKey: profile.key,
    season,
    capturedAtUtc: `2026-07-13T00:00:0${season - 2021}.000Z`,
    providerLeagueId: 292,
    providerName: "K League 1",
    providerCountry: "South-Korea",
    fixtureCount: fixtures.filter((row) => row.season === season).length,
  }));
}

test("empty device history is blocked by G10 and never promoted", async () => {
  const report = await runFormalValidation({
    profile,
    fixtures: [],
    snapshots: [],
    generatedAt: new Date("2026-07-13T00:00:00.000Z"),
  });
  assert.equal(report.outcome, "BLOCKED");
  assert.equal(report.recommendation, "HOLD");
  const g10 = report.gates.find((gate) => gate.id === "G10");
  assert.equal(g10?.status, "BLOCKED");
  assert.match(g10?.threshold ?? "", /2023–2024 共456场/);
  assert.match(g10?.threshold ?? "", /胜平负与大小2\.5各覆盖≥95%/);
  assert.match(g10?.threshold ?? "", /同一博彩公司/);
  assert.match(g10?.threshold ?? "", /开球前至少5分钟/);
  assert.match(g10?.threshold ?? "", /去水概率和=1/);
  assert.match(g10?.threshold ?? "", /全部样本外/);
  assert.match(g10?.detail ?? "", /G10 未通过不得正式发布/);
  assert.equal(report.input.evaluatedTargetCount, 0);
  assert.equal(report.reportSha256.length, 64);
});

test("K1 validation uses the latest 300 strict walk-forward targets and emits aggregates only", async () => {
  const fixtures = syntheticFixtures();
  const snapshots = snapshotMeta(fixtures);
  const progress: number[] = [];
  const report = await runFormalValidation({
    profile,
    fixtures,
    snapshots,
    generatedAt: new Date("2026-07-13T00:00:00.000Z"),
  }, {
    yieldEvery: 500,
    onProgress: (value) => progress.push(value.processed),
  });
  assert.equal(report.input.evaluatedTargetCount, 300);
  assert.equal(report.models.independent.evaluated, 300);
  assert.equal(report.models.liz60.evaluated, 300);
  assert.equal(report.models.liz61.evaluated, 300);
  assert.equal(report.gates.find((gate) => gate.id === "identity")?.status, "PASS");
  assert.equal(report.gates.find((gate) => gate.id === "sample")?.status, "PASS");
  assert.equal(report.gates.find((gate) => gate.id === "pit")?.status, "PASS");
  assert.equal(report.gates.find((gate) => gate.id === "convergence")?.status, "PASS");
  assert.equal(report.gates.find((gate) => gate.id === "G10")?.status, "BLOCKED");
  assert.equal(report.outcome, "BLOCKED");
  assert.equal(report.recommendation, "HOLD");
  assert.equal(progress.at(-1), 300);
  const json = JSON.stringify(report);
  for (const forbidden of ["homeTeamId", "awayTeamId", "homeTeamName", "awayTeamName", "payload"]) {
    assert.equal(json.includes(forbidden), false, `${forbidden} leaked into aggregate report`);
  }
  assert.equal(await reportMatchesInputs(report, { profile, fixtures, snapshots }), true);
  assert.equal(await reportMatchesInputs(report, { profile, fixtures: fixtures.slice(0, -1), snapshots }), false);

  const withoutG10 = {
    ...report,
    gates: report.gates.filter((gate) => gate.id !== "G10"),
  } as ValidationReport;
  assert.equal(await reportMatchesInputs(withoutG10, { profile, fixtures, snapshots }), false);

  const { reportSha256: ignoredHash, ...extraGateBody } = {
    ...report,
    gates: [...report.gates, { id: "unknown", label: "未知", status: "PASS" as const, value: "1", threshold: "1", detail: "不应接受" }],
  };
  void ignoredHash;
  const extraGate = {
    ...extraGateBody,
    reportSha256: await sha256Canonical(extraGateBody),
  } as ValidationReport;
  assert.equal(await reportMatchesInputs(extraGate, { profile, fixtures, snapshots }), false);

  const oldManifest = {
    ...report,
    gateManifest: "liz-formal-gates-v1",
  } as unknown as ValidationReport;
  assert.equal(await reportMatchesInputs(oldManifest, { profile, fixtures, snapshots }), false);

  const forgedPass = {
    ...report,
    outcome: "PASS",
    recommendation: "PROMOTE_RC",
    gates: report.gates.map((gate) => gate.id === "G10" ? { ...gate, status: "PASS" } : gate),
  } as ValidationReport;
  assert.equal(await reportMatchesInputs(forgedPass, { profile, fixtures, snapshots }), false);
});

test("report hashing is canonical and cancellation fails closed", async () => {
  assert.equal(await sha256Canonical({ b: 2, a: 1 }), await sha256Canonical({ a: 1, b: 2 }));
  await assert.rejects(
    runFormalValidation({ profile, fixtures: syntheticFixtures(90), snapshots: [] }, { shouldCancel: () => true }),
    ValidationCancelledError,
  );
});
