import { classifyRound, normalize, type LeagueProfile } from "./league-profiles";
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
