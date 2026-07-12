import assert from "node:assert/strict";
import test from "node:test";
import {
  MARKET_VALUE_UNAVAILABLE_NOTE,
  fetchTeamSquad,
  liz61MatchStrength,
  parseTeamSquad,
  positionInChinese,
} from "../src/match-details";
import type { StoredPrediction } from "../src/storage";

const providerSquad = [{
  team: { id: 10, name: "测试队" },
  players: [
    { id: 1, name: "一号球员", age: 28, number: 1, position: "Goalkeeper" },
    { id: 2, name: "二号球员", age: 24, number: 4, position: "Defender" },
    { id: 3, name: "三号球员", age: null, number: null, position: "Midfielder" },
    { id: 4, name: "四号球员", age: 21, number: 9, position: "Attacker" },
  ],
}];

function prediction(): StoredPrediction {
  return {
    id: "7:now", fixtureId: 7, profileKey: "kor_k_league_1", generatedAtUtc: "2026-07-13T00:00:00Z",
    kickoffUtc: "2026-07-14T00:00:00Z", home: "主队", away: "客队", forecastState: "PREVIEW",
    validationState: "ALPHA", homeLambda: 1.4, awayLambda: 1, eligibleFixtureCount: 300,
    versions: {
      liz61: { homeWin: 0.55, draw: 0.25, awayWin: 0.2, over25: 0.5, bttsYes: 0.5, topScores: [] },
    },
  };
}

test("position labels are stable Chinese and unknown values fail into 其他", () => {
  assert.equal(positionInChinese("Goal Keeper"), "门将");
  assert.equal(positionInChinese("D"), "后卫");
  assert.equal(positionInChinese("midfield"), "中场");
  assert.equal(positionInChinese("Forward"), "前锋");
  assert.equal(positionInChinese("Utility"), "其他");
  assert.throws(() => positionInChinese(""), /球员位置/);
});

test("strict squad parser returns required fields and never fabricates market value", () => {
  const result = parseTeamSquad(providerSquad, 10);
  assert.equal(result.schema, "liz-team-squad-v1");
  assert.equal(result.teamId, 10);
  assert.equal(result.players.length, 4);
  assert.deepEqual(result.players.map((row) => row.position), ["门将", "后卫", "中场", "前锋"]);
  assert.equal(result.players[2].age, null);
  assert.equal(result.players[2].number, null);
  for (const player of result.players) {
    assert.equal(player.marketValue, null);
    assert.equal(player.marketValueNote, MARKET_VALUE_UNAVAILABLE_NOTE);
  }
  assert.equal(result.marketValueNote, "API-Football 当前接口不提供可靠身价");
  assert.match(result.sourceNote, /阵容数据来自/);
});

test("strict squad parser rejects ambiguous teams, malformed fields, and duplicate players", () => {
  assert.throws(() => parseTeamSquad([], 10), /唯一匹配球队/);
  assert.throws(() => parseTeamSquad([...providerSquad, ...providerSquad], 10), /唯一匹配球队/);
  assert.throws(() => parseTeamSquad([{ team: { id: 10, name: "队" }, players: [{ id: 1, name: "甲", age: -1, number: 1, position: "D" }] }], 10), /年龄/);
  assert.throws(() => parseTeamSquad([{ team: { id: 10, name: "队" }, players: [{ id: 1, name: "甲", age: 20, number: 1, position: "D" }, { id: 1, name: "乙", age: 21, number: 2, position: "F" }] }], 10), /重复球员编号/);
  assert.throws(() => parseTeamSquad(providerSquad, 0), /球队编号/);
});

test("lazy fetch uses the exported API client and exact players/squads team query", async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = "";
  let calledKey = "";
  globalThis.fetch = async (input, init) => {
    calledUrl = String(input);
    calledKey = new Headers(init?.headers).get("x-apisports-key") ?? "";
    return new Response(JSON.stringify({ response: providerSquad, errors: [], results: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await fetchTeamSquad("device-key-test", 10);
    assert.equal(result.teamId, 10);
    assert.equal(calledUrl, "https://v3.football.api-sports.io/players/squads?team=10");
    assert.equal(calledKey, "device-key-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Liz6.1 match strength is expected-points share, sums to 100, and is not valuation", () => {
  const result = liz61MatchStrength(prediction());
  assert.equal(result.model, "Liz6.1");
  assert.equal(result.home.index, 67.5);
  assert.equal(result.away.index, 32.5);
  assert.equal(result.home.index + result.away.index, 100);
  assert.match(result.formula, /主胜.*平局.*客胜/);
  assert.match(result.explanation, /本场.*不是球员身价.*不是跨赛事通用评级/);
});

test("strength index fails closed for missing or invalid Liz6.1 probabilities", () => {
  const missing = prediction();
  delete missing.versions.liz61;
  assert.throws(() => liz61MatchStrength(missing), /缺少 Liz6\.1/);
  const invalid = prediction();
  invalid.versions.liz61.homeWin = 0.8;
  assert.throws(() => liz61MatchStrength(invalid), /概率之和必须为1/);
  const nonFinite = prediction();
  nonFinite.versions.liz61.draw = Number.NaN;
  assert.throws(() => liz61MatchStrength(nonFinite), /平局概率无效/);
});
