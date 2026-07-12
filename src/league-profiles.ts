export type ValidationState = "SHADOW" | "ALPHA" | "RC" | "STABLE";
export type SeasonBasis = "EUROPEAN_START_YEAR" | "CALENDAR_YEAR" | "EDITION_YEAR";
export type RoundDisposition = "IN_SCOPE" | "EXCLUDED" | "QUARANTINE";

export type LeagueProfile = {
  key: string;
  shortName: string;
  name: string;
  country: string;
  accent: string;
  validationState: ValidationState;
  category: "DOMESTIC_LEAGUE" | "NATIONAL_TEAM_TOURNAMENT" | "CLUB_WORLD_TOURNAMENT" | "CONTINENTAL_CLUB_TOURNAMENT";
  minHistory: number;
  seasonBasis: SeasonBasis;
  seasons: readonly number[];
  requiredType: "League" | "Cup";
  searchTerms: readonly string[];
  acceptedNames: readonly string[];
  acceptedCountries: readonly string[];
  roundPolicy: "REGULAR" | "K1_SPLIT" | "FINLAND_SPLIT" | "CUP_MAIN_STAGE";
};

const YEARS = [2021, 2022, 2023, 2024, 2025, 2026] as const;

function league(
  key: string,
  shortName: string,
  name: string,
  country: string,
  accent: string,
  searchTerms: string[],
  acceptedNames: string[],
  acceptedCountries: string[],
  seasonBasis: SeasonBasis,
  roundPolicy: LeagueProfile["roundPolicy"] = "REGULAR",
  validationState: ValidationState = "SHADOW",
): LeagueProfile {
  return {
    key, shortName, name, country, accent, searchTerms, acceptedNames, acceptedCountries,
    seasonBasis, roundPolicy, validationState, seasons: YEARS, requiredType: "League",
    category: "DOMESTIC_LEAGUE", minHistory: 80,
  };
}

function cup(
  key: string,
  shortName: string,
  name: string,
  region: string,
  accent: string,
  searchTerms: string[],
  acceptedNames: string[],
  seasons: readonly number[],
  category: LeagueProfile["category"],
  seasonBasis: SeasonBasis = "EDITION_YEAR",
  minHistory = 40,
): LeagueProfile {
  return {
    key, shortName, name, country: region, accent, searchTerms, acceptedNames, seasons,
    acceptedCountries: ["World", "Europe", "Asia", "South-America", "South America"],
    seasonBasis, requiredType: "Cup", roundPolicy: "CUP_MAIN_STAGE", validationState: "SHADOW",
    category, minHistory,
  };
}

export const LEAGUE_PROFILES: readonly LeagueProfile[] = [
  league("kor_k_league_1", "K1", "韩国 K League 1", "韩国", "#78e8bd", ["K League 1"], ["K League 1"], ["South-Korea", "South Korea"], "CALENDAR_YEAR", "K1_SPLIT", "ALPHA"),
  league("chn_super_league", "中超", "中国足球超级联赛", "中国", "#f5bc5f", ["Chinese Super League", "Super League"], ["Super League", "Chinese Super League"], ["China"], "CALENDAR_YEAR"),
  league("nor_eliteserien", "挪超", "挪威超级联赛", "挪威", "#67c7f5", ["Eliteserien"], ["Eliteserien"], ["Norway"], "CALENDAR_YEAR"),
  league("fin_veikkausliiga", "芬超", "芬兰超级联赛", "芬兰", "#b59afb", ["Veikkausliiga"], ["Veikkausliiga"], ["Finland"], "CALENDAR_YEAR", "FINLAND_SPLIT"),
  league("eng_premier_league", "英超", "英格兰超级联赛", "英格兰", "#df8df5", ["Premier League"], ["Premier League"], ["England"], "EUROPEAN_START_YEAR"),
  league("esp_la_liga", "西甲", "西班牙甲级联赛", "西班牙", "#f28376", ["La Liga"], ["La Liga"], ["Spain"], "EUROPEAN_START_YEAR"),
  league("ita_serie_a", "意甲", "意大利甲级联赛", "意大利", "#799ff4", ["Serie A"], ["Serie A"], ["Italy"], "EUROPEAN_START_YEAR"),
  league("deu_bundesliga", "德甲", "德国甲级联赛", "德国", "#f26a6a", ["Bundesliga"], ["Bundesliga"], ["Germany"], "EUROPEAN_START_YEAR"),
  league("fra_ligue_1", "法甲", "法国甲级联赛", "法国", "#5ed7c1", ["Ligue 1"], ["Ligue 1"], ["France"], "EUROPEAN_START_YEAR"),
  cup("fifa_world_cup", "世界杯", "国际足联世界杯", "世界", "#f4cf75", ["World Cup", "FIFA World Cup"], ["World Cup", "FIFA World Cup"], [2018, 2022, 2026], "NATIONAL_TEAM_TOURNAMENT"),
  cup("uefa_euro", "欧洲杯", "欧洲足球锦标赛", "欧洲", "#70a5f8", ["Euro Championship", "European Championship", "UEFA EURO"], ["Euro Championship", "European Championship", "UEFA European Championship", "UEFA EURO"], [2016, 2020, 2024], "NATIONAL_TEAM_TOURNAMENT"),
  cup("conmebol_copa_america", "美洲杯", "南美洲国家杯", "南美洲", "#65ce80", ["Copa America", "CONMEBOL Copa America"], ["Copa America", "CONMEBOL Copa America"], [2019, 2021, 2024], "NATIONAL_TEAM_TOURNAMENT"),
  cup("uefa_champions_league", "欧冠", "欧洲冠军联赛", "欧洲", "#8790f5", ["UEFA Champions League", "Champions League"], ["UEFA Champions League", "Champions League"], YEARS, "CONTINENTAL_CLUB_TOURNAMENT", "EUROPEAN_START_YEAR", 80),
  cup("fifa_club_world_cup", "世俱杯", "国际足联俱乐部世界杯", "世界", "#ef9d69", ["FIFA Club World Cup", "Club World Cup"], ["FIFA Club World Cup", "Club World Cup"], [2021, 2022, 2023, 2025], "CLUB_WORLD_TOURNAMENT", "EDITION_YEAR", 20),
  cup("conmebol_libertadores", "解放者杯", "南美解放者杯", "南美洲", "#dcb05e", ["CONMEBOL Libertadores", "Copa Libertadores", "Libertadores"], ["CONMEBOL Libertadores", "Copa Libertadores", "Libertadores"], YEARS, "CONTINENTAL_CLUB_TOURNAMENT", "CALENDAR_YEAR", 80),
  cup("afc_champions_league_elite", "亚冠", "亚足联冠军精英联赛", "亚洲", "#e57ca7", ["AFC Champions League Elite", "AFC Champions League", "Asian Champions League"], ["AFC Champions League Elite", "AFC Champions League", "Asian Champions League"], YEARS, "CONTINENTAL_CLUB_TOURNAMENT", "EUROPEAN_START_YEAR", 80),
  cup("afc_asian_cup", "亚洲杯", "亚足联亚洲杯", "亚洲", "#62d3cb", ["Asian Cup", "AFC Asian Cup"], ["Asian Cup", "AFC Asian Cup"], [2019, 2023], "NATIONAL_TEAM_TOURNAMENT"),
  cup("uefa_europa_league", "欧联", "欧足联欧洲联赛", "欧洲", "#ef8956", ["UEFA Europa League", "Europa League"], ["UEFA Europa League", "Europa League"], YEARS, "CONTINENTAL_CLUB_TOURNAMENT", "EUROPEAN_START_YEAR", 80),
] as const;

const BY_KEY = new Map(LEAGUE_PROFILES.map((profile) => [profile.key, profile]));

export function getLeagueProfile(key: string): LeagueProfile {
  const profile = BY_KEY.get(key);
  if (!profile) throw new RangeError(`不支持的赛事：${key}`);
  return profile;
}

export function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function classifyRound(profile: LeagueProfile, rawRound?: string | null): RoundDisposition {
  const round = rawRound?.normalize("NFKC").trim() ?? "";
  if (!round) return "QUARANTINE";
  if (profile.roundPolicy === "CUP_MAIN_STAGE") {
    if (/(qualif(?:ication|ier|ying)|preliminary)/i.test(round)) return "EXCLUDED";
    if (/^(group stage(?:\s*-\s*\d+)?|group\s+[A-Z0-9]+(?:\s*-\s*\d+)?|league stage(?:\s*-\s*\d+|\s+matchday\s+\d+)?|matchday\s*[- ]?\s*\d+|round of (32|16)|8th finals|quarter-?finals?|semi-?finals?|final|(?:third|3rd)[- ]place(?: (?:match|final|play-?off))?|knockout (?:phase|round) play-?offs?)$/i.test(round)) return "IN_SCOPE";
    return /(play-?off|first round|second round|third round|1st round|2nd round|3rd round)/i.test(round) ? "EXCLUDED" : "QUARANTINE";
  }
  if (/^Regular Season\s*-\s*\d+$/i.test(round)) return "IN_SCOPE";
  if ((profile.roundPolicy === "K1_SPLIT" || profile.roundPolicy === "FINLAND_SPLIT") && /^(Championship Round|Relegation Round|Championship Group|Relegation Group)\s*-\s*\d+$/i.test(round)) return "IN_SCOPE";
  if (/(play-?off|qualification|promotion|relegation|final|tie.?breaker)/i.test(round)) return "EXCLUDED";
  return "QUARANTINE";
}
