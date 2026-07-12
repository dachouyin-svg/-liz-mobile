import { classifyRound, normalize, type LeagueProfile } from "./league-profiles";
import type { NormalizedOddsInput } from "./match-analysis";
import type { StoredFixture } from "./storage";

const API_BASE = "https://v3.football.api-sports.io";

export type ApiEnvelope<T = unknown> = {
  get?: string;
  parameters?: Record<string, unknown> | unknown[];
  errors?: Record<string, string> | string[] | string;
  results?: number;
  paging?: { current: number; total: number };
  response: T;
};

export class ApiFootballError extends Error {
  constructor(message: string, readonly code = "API_FOOTBALL_ERROR") { super(message); }
}

function describeErrors(errors: ApiEnvelope["errors"]): string | null {
  if (!errors) return null;
  if (typeof errors === "string") return errors.trim() || null;
  if (Array.isArray(errors)) return errors.filter(Boolean).join("；") || null;
  const messages = Object.values(errors).filter(Boolean);
  return messages.length ? messages.join("；") : null;
}

export async function apiGet<T>(apiKey: string, endpoint: string, parameters: Record<string, string | number> = {}): Promise<ApiEnvelope<T>> {
  const query = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, String(value)]));
  const url = `${API_BASE}/${endpoint}${query.size ? `?${query}` : ""}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers: { "x-apisports-key": apiKey, accept: "application/json" }, cache: "no-store" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiFootballError(`浏览器无法直连 API-Football（可能是 CORS 或网络限制）：${detail}`, "DIRECT_BROWSER_BLOCKED");
  }
  let envelope: ApiEnvelope<T>;
  try { envelope = await response.json() as ApiEnvelope<T>; }
  catch { throw new ApiFootballError(`API-Football 返回了无法解析的响应 (${response.status})`, "INVALID_RESPONSE"); }
  if (!response.ok) throw new ApiFootballError(`API-Football 请求失败 (${response.status})`, "HTTP_ERROR");
  const providerError = describeErrors(envelope.errors);
  if (providerError) throw new ApiFootballError(providerError, "PROVIDER_ERROR");
  return envelope;
}

type LeagueCatalogItem = {
  league?: { id?: number; name?: string; type?: string };
  country?: { name?: string | null; code?: string | null };
  seasons?: Array<{ year?: number }>;
};

export type ResolvedLeague = { providerLeagueId: number; providerName: string; providerCountry: string; season: number };

export async function validateApiKey(apiKey: string): Promise<string | null> {
  const envelope = await apiGet<Record<string, unknown>>(apiKey, "status");
  const response = envelope.response;
  if (!response || typeof response !== "object") return null;
  const subscription = response.subscription;
  if (subscription && typeof subscription === "object" && "plan" in subscription) return String(subscription.plan);
  return null;
}

export async function resolveLeague(apiKey: string, profile: LeagueProfile, season: number): Promise<ResolvedLeague> {
  const acceptedNames = new Set(profile.acceptedNames.map(normalize));
  const acceptedCountries = new Set(profile.acceptedCountries.map(normalize));
  const matches = new Map<number, ResolvedLeague>();
  for (const search of profile.searchTerms) {
    const envelope = await apiGet<LeagueCatalogItem[]>(apiKey, "leagues", { search });
    if (!Array.isArray(envelope.response)) continue;
    for (const item of envelope.response) {
      const id = item.league?.id;
      const name = item.league?.name?.trim() ?? "";
      const country = item.country?.name?.trim() ?? "World";
      const type = item.league?.type?.trim() ?? "";
      const hasSeason = item.seasons?.some((candidate) => candidate.year === season) ?? false;
      if (!Number.isSafeInteger(id) || !acceptedNames.has(normalize(name)) || type !== profile.requiredType || !hasSeason) continue;
      if (profile.requiredType === "League" && !acceptedCountries.has(normalize(country))) continue;
      matches.set(id as number, { providerLeagueId: id as number, providerName: name, providerCountry: country, season });
    }
    if (matches.size === 1) break;
  }
  if (matches.size === 0) throw new ApiFootballError(`${profile.shortName} ${season} 未找到唯一官方赛事，请稍后重试`, "LEAGUE_NOT_FOUND");
  if (matches.size > 1) throw new ApiFootballError(`${profile.shortName} ${season} 匹配到多个赛事，已为安全阻断`, "LEAGUE_AMBIGUOUS");
  return [...matches.values()][0];
}

type ProviderFixture = {
  fixture?: { id?: number; date?: string; timestamp?: number; status?: { short?: string } };
  league?: { id?: number; season?: number; round?: string };
  teams?: { home?: { id?: number; name?: string }; away?: { id?: number; name?: string } };
  score?: { fulltime?: { home?: number | null; away?: number | null } };
};

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new ApiFootballError(`API 数据缺少 ${label}`, "PROVIDER_CONTRACT_ERROR");
  return value as number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiFootballError(`API 数据缺少 ${label}`, "PROVIDER_CONTRACT_ERROR");
  return value.trim();
}

export function parseFixture(item: ProviderFixture, profile: LeagueProfile, resolved: ResolvedLeague, syncedAtUtc: string): StoredFixture {
  const fixtureId = integer(item.fixture?.id, "fixture.id");
  const timestamp = integer(item.fixture?.timestamp, "fixture.timestamp");
  const kickoffUtc = text(item.fixture?.date, "fixture.date");
  const season = integer(item.league?.season, "league.season");
  if (item.league?.id !== resolved.providerLeagueId || season !== resolved.season) throw new ApiFootballError("赛事身份与已解析目录不一致", "IDENTITY_MISMATCH");
  const statusShort = text(item.fixture?.status?.short, "fixture.status.short");
  const completed = profile.requiredType === "Cup" ? ["FT", "AET", "PEN"].includes(statusShort) : statusShort === "FT";
  const homeScore = item.score?.fulltime?.home;
  const awayScore = item.score?.fulltime?.away;
  return {
    fixtureId, profileKey: profile.key, season, kickoffUtc, timestamp, statusShort,
    round: item.league?.round?.trim() ?? "",
    scope: classifyRound(profile, item.league?.round),
    homeTeamId: integer(item.teams?.home?.id, "teams.home.id"),
    awayTeamId: integer(item.teams?.away?.id, "teams.away.id"),
    homeTeamName: text(item.teams?.home?.name, "teams.home.name"),
    awayTeamName: text(item.teams?.away?.name, "teams.away.name"),
    homeGoals90: completed && Number.isSafeInteger(homeScore) ? homeScore as number : null,
    awayGoals90: completed && Number.isSafeInteger(awayScore) ? awayScore as number : null,
    syncedAtUtc,
  };
}

export async function fetchSeasonFixtures(apiKey: string, profile: LeagueProfile, season: number): Promise<{ resolved: ResolvedLeague; fixtures: StoredFixture[]; raw: unknown }> {
  const resolved = await resolveLeague(apiKey, profile, season);
  const envelope = await apiGet<ProviderFixture[]>(apiKey, "fixtures", { league: resolved.providerLeagueId, season, timezone: "UTC" });
  if (!Array.isArray(envelope.response)) throw new ApiFootballError("赛程目录不是数组", "PROVIDER_CONTRACT_ERROR");
  const syncedAtUtc = new Date().toISOString();
  return { resolved, fixtures: envelope.response.map((item) => parseFixture(item, profile, resolved, syncedAtUtc)), raw: envelope };
}

export async function fetchFixtureById(apiKey: string, profile: LeagueProfile, season: number, fixtureId: number): Promise<StoredFixture> {
  const resolved = await resolveLeague(apiKey, profile, season);
  const envelope = await apiGet<ProviderFixture[]>(apiKey, "fixtures", { id: fixtureId, timezone: "UTC" });
  if (!Array.isArray(envelope.response) || envelope.response.length !== 1) throw new ApiFootballError("实时赛程查询未返回唯一比赛", "FIXTURE_NOT_UNIQUE");
  return parseFixture(envelope.response[0], profile, resolved, new Date().toISOString());
}

export type ProviderOddsItem = {
  fixture?: { id?: number };
  update?: string;
  bookmakers?: Array<{
    id?: number;
    name?: string;
    bets?: Array<{
      name?: string;
      values?: Array<{ value?: string; odd?: string | number }>;
    }>;
  }>;
};

function decimalOdd(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 1 ? parsed : null;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function marketName(value: string | undefined): string {
  return value?.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ") ?? "";
}

function selectionName(value: string | undefined): string {
  return marketName(value).replace(/\s+/g, " ");
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/**
 * Build a non-actionable market consensus from cross-bookmaker medians.
 * The result is deliberately labelled as reference-only: its selections may
 * not coexist at a single bookmaker and therefore are never treated as an
 * executable price.
 */
export function normalizeProviderOdds(
  response: readonly ProviderOddsItem[],
  fixtureId: number,
  retrievedAtUtc = new Date().toISOString(),
): NormalizedOddsInput {
  const prices = new Map<string, number[]>();
  const bookmakers = new Map<number | string, string>();
  const providerUpdates: string[] = [];
  const add = (key: string, value: unknown) => {
    const parsed = decimalOdd(value);
    if (parsed === null) return;
    const rows = prices.get(key) ?? [];
    rows.push(parsed);
    prices.set(key, rows);
  };
  for (const item of response) {
    if (item.fixture?.id !== fixtureId) continue;
    const update = validIso(item.update);
    if (update) providerUpdates.push(update);
    for (const bookmaker of item.bookmakers ?? []) {
      const bookmakerName = bookmaker.name?.normalize("NFKC").trim();
      if (!bookmakerName || !Number.isSafeInteger(bookmaker.id) || (bookmaker.id as number) <= 0) continue;
      bookmakers.set(bookmaker.id as number, bookmakerName);
      for (const bet of bookmaker.bets ?? []) {
        const name = marketName(bet.name);
        const isOneXTwo = ["match winner", "1x2", "fulltime result"].includes(name);
        const isTotals = ["goals over/under", "over/under", "total goals"].includes(name);
        const isBtts = ["both teams score", "both teams to score"].includes(name);
        if (!isOneXTwo && !isTotals && !isBtts) continue;
        for (const value of bet.values ?? []) {
          const selection = selectionName(value.value);
          if (isOneXTwo && selection === "home") add("home", value.odd);
          else if (isOneXTwo && selection === "draw") add("draw", value.odd);
          else if (isOneXTwo && selection === "away") add("away", value.odd);
          else if (isTotals && /^over 2[.,]5$/.test(selection)) add("over25", value.odd);
          else if (isTotals && /^under 2[.,]5$/.test(selection)) add("under25", value.odd);
          else if (isBtts && selection === "yes") add("bttsYes", value.odd);
          else if (isBtts && selection === "no") add("bttsNo", value.odd);
        }
      }
    }
  }
  const home = median(prices.get("home") ?? []);
  const draw = median(prices.get("draw") ?? []);
  const away = median(prices.get("away") ?? []);
  const over = median(prices.get("over25") ?? []);
  const under = median(prices.get("under25") ?? []);
  const yes = median(prices.get("bttsYes") ?? []);
  const no = median(prices.get("bttsNo") ?? []);
  const oneXTwo = home && draw && away ? { home, draw, away } : undefined;
  const overUnder25 = over && under ? { over, under } : undefined;
  const btts = yes && no ? { yes, no } : undefined;
  const completeMarketCount = [oneXTwo, overUnder25, btts].filter(Boolean).length;
  const bookmakerNames = [...bookmakers.values()].sort((left, right) => left.localeCompare(right, "zh-CN"));
  return {
    ...(oneXTwo ? { oneXTwo } : {}),
    ...(overUnder25 ? { overUnder25 } : {}),
    ...(btts ? { btts } : {}),
    provenance: {
      source: "API_FOOTBALL",
      status: completeMarketCount === 0 ? "NO_MARKET" : completeMarketCount === 3 ? "OK" : "PARTIAL",
      retrievedAtUtc: validIso(retrievedAtUtc) ?? new Date().toISOString(),
      providerUpdatedAtUtc: providerUpdates.sort().at(-1) ?? null,
      bookmakerCount: bookmakerNames.length,
      bookmakerNames,
      pricingMethod: "CROSS_BOOKMAKER_MEDIAN",
      actionable: false,
      detail: completeMarketCount === 0
        ? "API-Football 未返回完整的胜平负、大小2.5或双方进球市场"
        : completeMarketCount < 3 ? `仅取得 ${completeMarketCount}/3 个完整参考市场` : "取得三个完整的跨公司中位参考市场",
    },
  };
}

export async function fetchFixtureOdds(apiKey: string, fixtureId: number): Promise<NormalizedOddsInput> {
  const envelope = await apiGet<ProviderOddsItem[]>(apiKey, "odds", { fixture: fixtureId });
  const retrievedAtUtc = new Date().toISOString();
  return Array.isArray(envelope.response)
    ? normalizeProviderOdds(envelope.response, fixtureId, retrievedAtUtc)
    : normalizeProviderOdds([], fixtureId, retrievedAtUtc);
}
