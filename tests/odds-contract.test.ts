import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProviderOdds } from "../src/api-football";

test("provider odds become a traceable, explicitly non-actionable median reference", () => {
  const response = [{
    fixture: { id: 1506999 },
    update: "2026-07-13T00:00:00Z",
    bookmakers: [
      { id: 1, name: "甲公司", bets: [
        { name: "Match Winner", values: [{ value: "Home", odd: "2.10" }, { value: "Draw", odd: "3.20" }, { value: "Away", odd: "3.60" }] },
        { name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "1.95" }, { value: "Under 2.5", odd: "1.85" }] },
        { name: "Both Teams Score", values: [{ value: "Yes", odd: "1.80" }, { value: "No", odd: "2.00" }] },
      ] },
      { id: 2, name: "乙公司", bets: [
        { name: "Match Winner", values: [{ value: "Home", odd: 2.3 }, { value: "Draw", odd: 3.4 }, { value: "Away", odd: 3.8 }] },
        { name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: 2.05 }, { value: "Under 2.5", odd: 1.75 }] },
      ] },
    ],
  }];
  assert.deepEqual(normalizeProviderOdds(response, 1506999, "2026-07-13T00:01:00Z"), {
    oneXTwo: { home: 2.2, draw: 3.3, away: 3.7 },
    overUnder25: { over: 2, under: 1.8 },
    btts: { yes: 1.8, no: 2 },
    provenance: {
      source: "API_FOOTBALL",
      status: "OK",
      retrievedAtUtc: "2026-07-13T00:01:00.000Z",
      providerUpdatedAtUtc: "2026-07-13T00:00:00.000Z",
      bookmakerCount: 2,
      bookmakerNames: ["甲公司", "乙公司"],
      pricingMethod: "CROSS_BOOKMAKER_MEDIAN",
      actionable: false,
      detail: "取得三个完整的跨公司中位参考市场",
    },
  });
});

test("wrong fixture, partial markets, and invalid prices fail closed with provenance", () => {
  const empty = normalizeProviderOdds([{ fixture: { id: 2 }, bookmakers: [] }], 1, "2026-07-13T00:01:00Z");
  assert.equal(empty.provenance?.status, "NO_MARKET");
  assert.equal(empty.oneXTwo, undefined);
  assert.equal(empty.provenance?.actionable, false);

  const invalid = normalizeProviderOdds([{
    fixture: { id: 1 },
    bookmakers: [{ id: 1, name: "甲公司", bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "1.00" }] }] }],
  }], 1, "2026-07-13T00:01:00Z");
  assert.equal(invalid.provenance?.status, "NO_MARKET");

  const partial = normalizeProviderOdds([{
    fixture: { id: 1 },
    bookmakers: [{ id: 1, name: "甲公司", bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "2.00" }, { value: "Draw", odd: "3.00" }, { value: "Away", odd: "4.00" }] }] }],
  }], 1, "2026-07-13T00:01:00Z");
  assert.equal(partial.provenance?.status, "PARTIAL");
  assert.equal(partial.provenance?.bookmakerCount, 1);
  assert.ok(partial.oneXTwo);

  const anonymous = normalizeProviderOdds([{
    fixture: { id: 1 },
    bookmakers: [{ bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "2.00" }, { value: "Draw", odd: "3.00" }, { value: "Away", odd: "4.00" }] }] }],
  }], 1, "2026-07-13T00:01:00Z");
  assert.equal(anonymous.provenance?.status, "NO_MARKET");
  assert.equal(anonymous.provenance?.bookmakerCount, 0);
  assert.equal(anonymous.oneXTwo, undefined);
});
