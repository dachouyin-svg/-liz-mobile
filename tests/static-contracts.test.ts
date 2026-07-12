import assert from "node:assert/strict";
import test from "node:test";
import { LEAGUE_PROFILES, classifyRound, getLeagueProfile } from "../src/league-profiles";
import { parseFixture } from "../src/api-football";
import { forecastStateFor } from "../src/model";

test("18 profiles are unique and only K1 is ALPHA", () => {
  assert.equal(LEAGUE_PROFILES.length, 18);
  assert.equal(new Set(LEAGUE_PROFILES.map((profile) => profile.key)).size, 18);
  assert.equal(LEAGUE_PROFILES.filter((profile) => profile.requiredType === "Cup").length, 9);
  assert.deepEqual(LEAGUE_PROFILES.filter((profile) => profile.validationState === "ALPHA").map((profile) => profile.key), ["kor_k_league_1"]);
});

test("round policies fail closed", () => {
  const cup = getLeagueProfile("uefa_champions_league");
  for (const round of ["Group A - 1", "League Stage - 8", "Knockout Phase Play-offs", "Round of 16", "Final"]) assert.equal(classifyRound(cup, round), "IN_SCOPE");
  assert.equal(classifyRound(cup, "3rd Qualifying Round"), "EXCLUDED");
  assert.equal(classifyRound(cup, "Mystery Phase"), "QUARANTINE");
  assert.equal(classifyRound(getLeagueProfile("kor_k_league_1"), "Regular Season - 8"), "IN_SCOPE");
});

function provider(status: string, fulltime: { home: number; away: number }) {
  return {
    fixture: { id: 9001, date: "2022-12-18T15:00:00Z", timestamp: 1_671_375_600, status: { short: status } },
    league: { id: 1, season: 2022, round: "Final" },
    teams: { home: { id: 11, name: "Home" }, away: { id: 22, name: "Away" } },
    score: { fulltime },
  };
}

test("cup AET/PEN uses fulltime 90-minute score; league PEN is excluded from training", () => {
  const cup = getLeagueProfile("fifa_world_cup");
  const cupRow = parseFixture(provider("PEN", { home: 2, away: 2 }), cup, { providerLeagueId: 1, providerName: "World Cup", providerCountry: "World", season: 2022 }, "2026-07-13T00:00:00Z");
  assert.equal(cupRow.homeGoals90, 2);
  assert.equal(cupRow.awayGoals90, 2);
  const league = getLeagueProfile("kor_k_league_1");
  const item = provider("PEN", { home: 1, away: 1 });
  item.league = { id: 292, season: 2022, round: "Regular Season - 1" };
  const leagueRow = parseFixture(item, league, { providerLeagueId: 292, providerName: "K League 1", providerCountry: "South-Korea", season: 2022 }, "2026-07-13T00:00:00Z");
  assert.equal(leagueRow.homeGoals90, null);
  assert.equal(leagueRow.awayGoals90, null);
});

test("T60 lock uses exact 60-to-70-minute second boundaries", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");
  const base = now.getTime() / 1000;
  assert.equal(forecastStateFor(base + 4_200, now), "T60_LOCKED");
  assert.equal(forecastStateFor(base + 4_201, now), "PREVIEW");
  assert.equal(forecastStateFor(base + 3_600, now), "T60_LOCKED");
  assert.equal(forecastStateFor(base + 3_599, now), "PREVIEW");
});
