import { apiGet } from "./api-football";
import type { StoredPrediction } from "./storage";

export const MARKET_VALUE_UNAVAILABLE_NOTE = "API-Football 当前接口不提供可靠身价" as const;

export type ChinesePosition = "门将" | "后卫" | "中场" | "前锋" | "其他";

export type SquadPlayer = {
  id: number;
  name: string;
  age: number | null;
  number: number | null;
  position: ChinesePosition;
  marketValue: null;
  marketValueNote: typeof MARKET_VALUE_UNAVAILABLE_NOTE;
};

export type TeamSquad = {
  schema: "liz-team-squad-v1";
  teamId: number;
  teamName: string;
  players: SquadPlayer[];
  marketValueNote: typeof MARKET_VALUE_UNAVAILABLE_NOTE;
  sourceNote: "阵容数据来自 API-Football 球队名单接口";
};

export type MatchStrengthIndex = {
  schema: "liz-match-strength-v1";
  model: "Liz6.1";
  home: { teamName: string; index: number };
  away: { teamName: string; index: number };
  formula: "主队=主胜+0.5×平局；客队=客胜+0.5×平局";
  explanation: string;
};

type ProviderSquadItem = {
  team?: { id?: unknown; name?: unknown };
  players?: unknown;
};

type ProviderPlayer = {
  id?: unknown;
  name?: unknown;
  age?: unknown;
  number?: unknown;
  position?: unknown;
};

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`球队名单缺少有效的${label}`);
  return value as number;
}

function nonNegativeIntegerOrNull(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`球员${label}必须是非负整数或空值`);
  return value as number;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.normalize("NFKC").trim()) throw new TypeError(`球队名单缺少有效的${label}`);
  return value.normalize("NFKC").trim();
}

/** Convert API-Football position labels to stable Chinese UI labels. */
export function positionInChinese(value: unknown): ChinesePosition {
  const normalized = requiredText(value, "球员位置").toLocaleLowerCase("en-US").replace(/[\s_-]+/g, " ");
  if (["goalkeeper", "goal keeper", "keeper", "gk", "g"].includes(normalized)) return "门将";
  if (["defender", "defence", "defense", "back", "df", "d"].includes(normalized)) return "后卫";
  if (["midfielder", "midfield", "mf", "m"].includes(normalized)) return "中场";
  if (["attacker", "forward", "striker", "fw", "f"].includes(normalized)) return "前锋";
  return "其他";
}

function parsePlayer(value: unknown): SquadPlayer {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("球队名单包含无效球员记录");
  const player = value as ProviderPlayer;
  return {
    id: positiveInteger(player.id, "球员编号"),
    name: requiredText(player.name, "球员姓名"),
    age: nonNegativeIntegerOrNull(player.age, "年龄"),
    number: nonNegativeIntegerOrNull(player.number, "球衣号码"),
    position: positionInChinese(player.position),
    marketValue: null,
    marketValueNote: MARKET_VALUE_UNAVAILABLE_NOTE,
  };
}

/** Strictly parse the single squad belonging to the requested team. */
export function parseTeamSquad(value: unknown, requestedTeamId: number): TeamSquad {
  positiveInteger(requestedTeamId, "球队编号");
  if (!Array.isArray(value)) throw new TypeError("球队名单响应必须是数组");
  const matches = value.filter((item): item is ProviderSquadItem => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return (item as ProviderSquadItem).team?.id === requestedTeamId;
  });
  if (matches.length !== 1) throw new TypeError("球队名单未返回唯一匹配球队");
  const match = matches[0];
  const teamId = positiveInteger(match.team?.id, "球队编号");
  const teamName = requiredText(match.team?.name, "球队名称");
  if (!Array.isArray(match.players)) throw new TypeError("球队名单缺少球员数组");
  const players = match.players.map(parsePlayer);
  const ids = new Set<number>();
  for (const player of players) {
    if (ids.has(player.id)) throw new TypeError("球队名单包含重复球员编号");
    ids.add(player.id);
  }
  return {
    schema: "liz-team-squad-v1",
    teamId,
    teamName,
    players,
    marketValueNote: MARKET_VALUE_UNAVAILABLE_NOTE,
    sourceNote: "阵容数据来自 API-Football 球队名单接口",
  };
}

/** Fetch one squad only when the caller expands a match card. */
export async function fetchTeamSquad(apiKey: string, teamId: number): Promise<TeamSquad> {
  positiveInteger(teamId, "球队编号");
  const envelope = await apiGet<ProviderSquadItem[]>(apiKey, "players/squads", { team: teamId });
  return parseTeamSquad(envelope.response, teamId);
}

function probability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`Liz6.1 ${label}概率无效`);
  }
  return value;
}

/**
 * A two-sided match index based only on Liz6.1 expected-points share.
 * It intentionally is not a player valuation or a universal club rating.
 */
export function liz61MatchStrength(prediction: StoredPrediction): MatchStrengthIndex {
  const liz61 = prediction.versions?.liz61;
  if (!liz61) throw new TypeError("预测记录缺少 Liz6.1 结果");
  const homeWin = probability(liz61.homeWin, "主胜");
  const draw = probability(liz61.draw, "平局");
  const awayWin = probability(liz61.awayWin, "客胜");
  const totalProbability = homeWin + draw + awayWin;
  if (Math.abs(totalProbability - 1) > 1e-6) throw new TypeError("Liz6.1 胜平负概率之和必须为1");
  const homeShare = homeWin + 0.5 * draw;
  const awayShare = awayWin + 0.5 * draw;
  const expectedPointsTotal = homeShare + awayShare;
  if (!Number.isFinite(expectedPointsTotal) || expectedPointsTotal <= 0) throw new TypeError("Liz6.1 对阵实力指数无法计算");
  const homeIndex = 100 * homeShare / expectedPointsTotal;
  const awayIndex = 100 - homeIndex;
  return {
    schema: "liz-match-strength-v1",
    model: "Liz6.1",
    home: { teamName: prediction.home, index: homeIndex },
    away: { teamName: prediction.away, index: awayIndex },
    formula: "主队=主胜+0.5×平局；客队=客胜+0.5×平局",
    explanation: "这是 Liz6.1 根据本场胜平负概率计算的对阵实力指数，主客之和为100；仅代表本场相对预期积分份额，不是球员身价，也不是跨赛事通用评级。",
  };
}
