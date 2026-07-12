import { useEffect, useMemo, useRef, useState } from "react";
import { ApiFootballError, apiGet, fetchFixtureById, fetchFixtureOdds, fetchSeasonFixtures, validateApiKey } from "./api-football";
import { clearDeviceApiKey, hasDeviceApiKey, loadDeviceApiKey, saveDeviceApiKey } from "./device-key-vault";
import { getLeagueProfile, LEAGUE_PROFILES } from "./league-profiles";
import { makePrediction } from "./model";
import { analyzeMatch, isAnalysisExpired, isCurrentMatchAnalysis, type NormalizedOddsInput } from "./match-analysis";
import { fetchTeamSquad, liz61MatchStrength, type MatchStrengthIndex, type TeamSquad } from "./match-details";
import { reportMatchesInputs, sanitizeValidationReport, type ValidationProgress, type ValidationReport } from "./validation";
import type { ValidationWorkerResponse } from "./validation.worker";
import {
  clearLocalData,
  deleteLocalMeta,
  exportLocalData,
  fixturesForProfile,
  getLocalMeta,
  importLocalData,
  predictionHistory,
  putFixtures,
  putLocalMeta,
  putPrediction,
  putSnapshot,
  replaceSeasonFixtures,
  syncSnapshotsForProfile,
  type StoredFixture,
  type StoredPrediction,
} from "./storage";

type Tab = "matches" | "history" | "validation" | "settings";
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type FixtureDetailState = {
  loading: boolean;
  homeSquad: TeamSquad | null;
  awaySquad: TeamSquad | null;
  strength: MatchStrengthIndex | null;
  strengthNote: string | null;
  squadNote: string | null;
};

const RC1_PROFILE_KEY = "kor_k_league_1";
const validationMetaKey = (profileKey: string) => `validation-report:${profileKey}`;

function percentage(value: number): string { return `${(value * 100).toFixed(1)}%`; }

function validationStateText(value: StoredPrediction["validationState"]): string {
  return ({ SHADOW: "观察", ALPHA: "测试", RC: "候选", STABLE: "正式" } as const)[value] ?? "未知";
}

function forecastStateText(value: StoredPrediction["forecastState"]): string {
  return value === "T60_LOCKED" ? "开球前60分钟锁定" : value === "PREVIEW" ? "赛前预览" : "状态未知";
}

function modelVersionText(value: string): string {
  return ({ independent: "独立泊松基线", liz60: "Liz6.0 冻结基线", liz61: "Liz6.1 主线" } as Record<string, string>)[value] ?? value;
}

function validPredictionVersion(value: unknown): value is StoredPrediction["versions"][string] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as StoredPrediction["versions"][string];
  const probabilities = [row.homeWin, row.draw, row.awayWin, row.over25, row.bttsYes];
  if (!probabilities.every((item) => Number.isFinite(item) && item >= 0 && item <= 1)) return false;
  if (Math.abs(row.homeWin + row.draw + row.awayWin - 1) > 1e-6 || !Array.isArray(row.topScores)) return false;
  return row.topScores.every((score) => score && typeof score.score === "string" && Number.isFinite(score.probability) && score.probability >= 0 && score.probability <= 1);
}

function validPredictionRecord(value: StoredPrediction): boolean {
  return typeof value.id === "string"
    && Number.isSafeInteger(value.fixtureId)
    && typeof value.profileKey === "string"
    && typeof value.home === "string" && typeof value.away === "string"
    && typeof value.generatedAtUtc === "string" && Number.isFinite(Date.parse(value.generatedAtUtc))
    && typeof value.kickoffUtc === "string" && Number.isFinite(Date.parse(value.kickoffUtc))
    && ["PREVIEW", "T60_LOCKED"].includes(value.forecastState)
    && ["SHADOW", "ALPHA", "RC", "STABLE"].includes(value.validationState)
    && Number.isFinite(value.homeLambda) && value.homeLambda > 0
    && Number.isFinite(value.awayLambda) && value.awayLambda > 0
    && Number.isSafeInteger(value.eligibleFixtureCount) && value.eligibleFixtureCount >= 0
    && Boolean(value.versions)
    && validPredictionVersion(value.versions?.liz60)
    && validPredictionVersion(value.versions?.liz61);
}

function historyTime(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "时间无效";
}

function roundInChinese(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  const translated = normalized
    .replace(/^Regular Season\s*-\s*/i, "常规赛第 ")
    .replace(/^Championship Round\s*-\s*/i, "冠军组第 ")
    .replace(/^Relegation Round\s*-\s*/i, "保级组第 ")
    .replace(/^Championship Group\s*-\s*/i, "冠军组第 ")
    .replace(/^Relegation Group\s*-\s*/i, "保级组第 ")
    .replace(/^Group Stage\s*-\s*/i, "小组赛第 ")
    .replace(/^Group\s+([A-Z0-9]+)\s*-\s*(\d+)$/i, "$1组第 $2 轮")
    .replace(/^League Stage\s*-\s*/i, "联赛阶段第 ")
    .replace(/^Matchday\s*-?\s*(\d+)$/i, "第 $1 轮")
    .replace(/^Round of 32$/i, "三十二强")
    .replace(/^Round of 16$/i, "十六强")
    .replace(/^8th Finals$/i, "十六强")
    .replace(/^Quarter-?finals?$/i, "四分之一决赛")
    .replace(/^Semi-?finals?$/i, "半决赛")
    .replace(/^(Third|3rd)[- ]Place(?: (?:Match|Final|Play-?off))?$/i, "季军赛")
    .replace(/^Knockout (?:Phase|Round) Play-?offs?$/i, "淘汰赛附加赛")
    .replace(/^Final$/i, "决赛");
  if (!translated) return "轮次待确认";
  return translated === normalized && /[A-Za-z]/.test(translated) ? "赛事阶段" : translated;
}

function apiIssueInChinese(error: unknown, subject: "赔率" | "球队名单"): string {
  if (error instanceof ApiFootballError) {
    if (error.code === "DIRECT_BROWSER_BLOCKED") return `${subject}服务当前无法连接，请检查网络后重试`;
    if (error.code === "HTTP_ERROR") return `${subject}服务请求失败，请稍后重试`;
    if (error.code === "PROVIDER_ERROR") return `${subject}服务暂时拒绝请求，请检查配额或稍后重试`;
  }
  return `${subject}暂时不可用，请稍后重试`;
}

function oddsFailure(error: unknown): NormalizedOddsInput {
  const detail = apiIssueInChinese(error, "赔率");
  return {
    provenance: {
      source: "API_FOOTBALL",
      status: "ERROR",
      retrievedAtUtc: new Date().toISOString(),
      providerUpdatedAtUtc: null,
      bookmakerCount: 0,
      bookmakerNames: [],
      pricingMethod: "CROSS_BOOKMAKER_MEDIAN",
      actionable: false,
      detail,
    },
  };
}

function bettingSelectionLabel(value: string): string {
  return ({
    HOME: "主胜", DRAW: "平局", AWAY: "客胜",
    OVER_2_5: "大于 2.5 球", UNDER_2_5: "小于 2.5 球",
    BTTS_YES: "双方进球", BTTS_NO: "至少一方不进球",
  } as Record<string, string>)[value] ?? value;
}

function kickoff(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function download(name: string, contents: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function withTimeout<T>(promise: Promise<T>, milliseconds = 12_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("请求超时")), milliseconds);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

export default function App() {
  const [selectedKey, setSelectedKey] = useState("kor_k_league_1");
  const profile = useMemo(() => getLeagueProfile(selectedKey), [selectedKey]);
  const [season, setSeason] = useState(profile.seasons.at(-1) ?? 2026);
  const [tab, setTab] = useState<Tab>("matches");
  const [connected, setConnected] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [plan, setPlan] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<StoredFixture[]>([]);
  const [history, setHistory] = useState<StoredPrediction[]>([]);
  const [prediction, setPrediction] = useState<StoredPrediction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("密钥与数据仅保存在这台设备");
  const [progress, setProgress] = useState<{ current: number; total: number; season: number } | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [validationProgress, setValidationProgress] = useState<ValidationProgress | null>(null);
  const [validationStale, setValidationStale] = useState(false);
  const [validationLoading, setValidationLoading] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [expandedFixtureId, setExpandedFixtureId] = useState<number | null>(null);
  const [fixtureDetails, setFixtureDetails] = useState<Record<number, FixtureDetailState>>({});
  const importRef = useRef<HTMLInputElement>(null);
  const validationWorkerRef = useRef<Worker | null>(null);
  const validationRunRef = useRef(0);
  const squadCacheRef = useRef(new Map<number, TeamSquad>());
  const profileLoadRef = useRef(0);
  const detailRunRef = useRef(0);

  const activeSeason = profile.seasons.includes(season) ? season : profile.seasons.at(-1) ?? season;
  const upcoming = useMemo(() => fixtures.filter((row) => row.profileKey === profile.key && row.statusShort === "NS" && row.scope === "IN_SCOPE" && row.timestamp * 1000 > Date.now()).slice(0, 40), [fixtures, profile.key]);
  const completedCount = useMemo(() => fixtures.filter((row) => row.profileKey === profile.key && row.homeGoals90 !== null && row.scope === "IN_SCOPE").length, [fixtures, profile.key]);
  const quarantineCount = useMemo(() => fixtures.filter((row) => row.profileKey === profile.key && row.scope === "QUARANTINE").length, [fixtures, profile.key]);
  const visibleHistory = useMemo(() => history.filter((row) => row.profileKey === profile.key), [history, profile.key]);

  async function cachedValidationForProfile(key: string): Promise<{ report: ValidationReport | null; stale: boolean }> {
    const targetProfile = getLeagueProfile(key);
    const [report, rows, snapshots] = await Promise.all([
      getLocalMeta<ValidationReport>(validationMetaKey(key)),
      fixturesForProfile(key),
      syncSnapshotsForProfile(key),
    ]);
    if (!report) return { report: null, stale: false };
    const current = await reportMatchesInputs(report, { profile: targetProfile, fixtures: rows, snapshots });
    return { report, stale: !current };
  }

  async function reloadProfile(key = selectedKey): Promise<void> {
    const requestId = profileLoadRef.current + 1;
    profileLoadRef.current = requestId;
    const [rows, predictions] = await Promise.all([fixturesForProfile(key), predictionHistory(key)]);
    if (profileLoadRef.current !== requestId) return;
    setFixtures(rows);
    setHistory(predictions);
  }

  useEffect(() => {
    hasDeviceApiKey().then((hasKey) => {
      setConnected(hasKey);
      if (hasKey) setMessage("API 已在此设备安全连接");
    });
    const onInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    window.addEventListener("beforeinstallprompt", onInstall);
    return () => window.removeEventListener("beforeinstallprompt", onInstall);
  }, []);

  useEffect(() => {
    setSeason(profile.seasons.at(-1) ?? new Date().getUTCFullYear());
    setPrediction(null);
    setFixtures([]);
    setHistory([]);
    detailRunRef.current += 1;
    setExpandedFixtureId(null);
    setFixtureDetails({});
    reloadProfile(profile.key).catch((error) => setMessage(error instanceof Error ? error.message : "本机数据读取失败"));
  }, [profile.key]);

  useEffect(() => {
    let cancelled = false;
    setValidationLoading(true);
    setValidationReport(null);
    setValidationStale(false);
    cachedValidationForProfile(profile.key)
      .then((cached) => {
        if (cancelled) return;
        setValidationReport(cached.report);
        setValidationStale(cached.stale);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "验证报告读取失败");
      })
      .finally(() => { if (!cancelled) setValidationLoading(false); });
    return () => { cancelled = true; };
  }, [profile.key]);

  useEffect(() => () => {
    validationRunRef.current += 1;
    validationWorkerRef.current?.terminate();
  }, []);

  async function connect(): Promise<void> {
    const key = apiKey.trim();
    if (key.length < 12) return setMessage("请输入有效的 API-Football 密钥");
    setBusy("connect");
    try {
      const currentPlan = await validateApiKey(key);
      await saveDeviceApiKey(key);
      setConnected(true);
      setPlan(currentPlan);
      setApiKey("");
      setMessage(`密钥已验证，并用不可导出的设备密钥加密${currentPlan ? `（${currentPlan}）` : ""}`);
      setTab("matches");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "API 连接失败");
    } finally { setBusy(null); }
  }

  async function invalidateValidationCache(profileKey: string): Promise<void> {
    if (profileKey === selectedKey) {
      setValidationReport(null);
      setValidationStale(false);
    }
    await deleteLocalMeta(validationMetaKey(profileKey));
  }

  async function syncOne(targetSeason: number, key: string): Promise<number> {
    const result = await fetchSeasonFixtures(key, profile, targetSeason);
    await replaceSeasonFixtures(profile.key, targetSeason, result.fixtures);
    await putSnapshot({
      id: `${profile.key}:${targetSeason}:${Date.now()}`,
      profileKey: profile.key,
      season: targetSeason,
      capturedAtUtc: new Date().toISOString(),
      providerLeagueId: result.resolved.providerLeagueId,
      providerName: result.resolved.providerName,
      providerCountry: result.resolved.providerCountry,
      fixtureCount: result.fixtures.length,
      payload: result.raw,
    });
    await invalidateValidationCache(profile.key);
    return result.fixtures.length;
  }

  async function syncSelected(): Promise<void> {
    setBusy("sync");
    setProgress({ current: 0, total: 1, season: activeSeason });
    try {
      const key = await loadDeviceApiKey();
      const count = await syncOne(activeSeason, key);
      await reloadProfile();
      detailRunRef.current += 1;
      setExpandedFixtureId(null);
      setFixtureDetails({});
      setMessage(`${profile.shortName} ${activeSeason} 同步完成：${count} 场`);
      setProgress({ current: 1, total: 1, season: activeSeason });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "同步失败");
      if (!await hasDeviceApiKey()) { setConnected(false); setTab("settings"); }
    } finally { setBusy(null); setTimeout(() => setProgress(null), 1200); }
  }

  async function syncAllSeasons(): Promise<void> {
    if (!window.confirm(`将按赛季逐步同步 ${profile.shortName} 的 ${profile.seasons.length} 个版本，会消耗 API 配额。继续吗？`)) return;
    setBusy("bootstrap");
    try {
      const key = await loadDeviceApiKey();
      let totalFixtures = 0;
      for (let index = 0; index < profile.seasons.length; index += 1) {
        const targetSeason = profile.seasons[index];
        setProgress({ current: index, total: profile.seasons.length, season: targetSeason });
        setMessage(`正在同步 ${profile.shortName} ${targetSeason}（${index + 1}/${profile.seasons.length}）`);
        totalFixtures += await syncOne(targetSeason, key);
        setProgress({ current: index + 1, total: profile.seasons.length, season: targetSeason });
        await reloadProfile();
        detailRunRef.current += 1;
        setExpandedFixtureId(null);
        setFixtureDetails({});
      }
      setMessage(`${profile.shortName} 历史同步完成：${totalFixtures} 场，本机共 ${profile.seasons.length} 个赛季`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "历史同步失败"); }
    finally { setBusy(null); setTimeout(() => setProgress(null), 1400); }
  }

  async function predict(row: StoredFixture): Promise<void> {
    setBusy(`predict-${row.fixtureId}`);
    try {
      if (row.profileKey !== profile.key) throw new Error("比赛与当前赛事不一致，请重新选择比赛");
      const key = await loadDeviceApiKey();
      const [live, odds] = await Promise.all([
        fetchFixtureById(key, profile, row.season, row.fixtureId),
        fetchFixtureOdds(key, row.fixtureId).catch(oddsFailure),
      ]);
      await putFixtures([live]);
      const rows = await fixturesForProfile(profile.key);
      const basePrediction = makePrediction(profile, live, rows);
      const hasReferenceMarket = Boolean(odds.oneXTwo || odds.overUnder25 || odds.btts);
      const result: StoredPrediction = {
        ...basePrediction,
        odds,
        ...(hasReferenceMarket && odds.provenance ? { oddsCapturedAtUtc: odds.provenance.retrievedAtUtc } : {}),
        analysis: analyzeMatch(basePrediction, odds),
      };
      await putPrediction(result);
      setPrediction(result);
      setHistory(await predictionHistory(profile.key));
      setMessage(result.forecastState === "T60_LOCKED" ? "T−60 预测已锁定并保存在此设备" : "赛前预览已生成并保存在此设备");
    } catch (error) { setMessage(error instanceof Error ? error.message : "预测失败"); }
    finally { setBusy(null); }
  }

  async function backup(): Promise<void> {
    setBusy("export");
    try {
      const data = await exportLocalData();
      download(`liz-mobile-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
      setMessage("本机数据已导出；API 密钥从不进入备份");
    } catch (error) { setMessage(error instanceof Error ? error.message : "导出失败"); }
    finally { setBusy(null); }
  }

  async function restore(file: File): Promise<void> {
    setBusy("import");
    try {
      const result = await importLocalData(JSON.parse(await file.text()));
      await reloadProfile();
      const cached = await cachedValidationForProfile(profile.key);
      setValidationReport(cached.report);
      setValidationStale(cached.stale);
      setMessage(`恢复完成：${result.fixtures} 场赛程，${result.predictions} 条预测，${result.snapshots} 个快照`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "恢复失败"); }
    finally { setBusy(null); if (importRef.current) importRef.current.value = ""; }
  }

  async function reset(): Promise<void> {
    if (!window.confirm("清除这台设备上的 API 密钥、赛程、快照和预测历史？此操作无法撤销。")) return;
    await Promise.all([clearDeviceApiKey(), clearLocalData()]);
    squadCacheRef.current.clear();
    detailRunRef.current += 1;
    setConnected(false); setPlan(null); setFixtures([]); setHistory([]); setPrediction(null); setExpandedFixtureId(null); setFixtureDetails({}); setValidationReport(null); setValidationStale(false); setMessage("本机数据已清除");
  }

  async function startFormalValidation(): Promise<void> {
    if (profile.key !== RC1_PROFILE_KEY) {
      setMessage("6.1.0-rc.2 首批只开放 K1 正式版验证");
      return;
    }
    const runId = validationRunRef.current + 1;
    validationRunRef.current = runId;
    setBusy("validation");
    setValidationProgress({ phase: "PREPARING", processed: 0, total: 0, evaluated: 0, skipped: 0 });
    setMessage("正在准备 K1 正式版验证；全过程只读取本机数据");
    try {
      const targetProfile = profile;
      const [rows, snapshots] = await Promise.all([
        fixturesForProfile(targetProfile.key),
        syncSnapshotsForProfile(targetProfile.key),
      ]);
      if (validationRunRef.current !== runId) return;
      const worker = new Worker(new URL("./validation.worker.ts", import.meta.url), { type: "module" });
      validationWorkerRef.current = worker;
      const finish = () => {
        if (validationWorkerRef.current === worker) validationWorkerRef.current = null;
        worker.terminate();
        setValidationProgress(null);
        setBusy(null);
      };
      worker.onmessage = (event: MessageEvent<ValidationWorkerResponse>) => {
        if (validationRunRef.current !== runId || validationWorkerRef.current !== worker) return;
        if (event.data.type === "progress") {
          setValidationProgress(event.data.progress);
          return;
        }
        if (event.data.type === "error") {
          finish();
          setMessage(event.data.message);
          return;
        }
        const report = event.data.report;
        finish();
        setValidationReport(report);
        setValidationStale(false);
        setMessage(report.outcome === "BLOCKED"
          ? "K1 验证已完成，但历史赔率审计 G10 阻断正式升级"
          : report.outcome === "PASS" ? "K1 全部门槛通过，具备升级候选版条件"
            : report.outcome === "FAIL" ? "K1 存在未通过门槛，继续保持测试阶段" : "K1 数据不足，部分门槛尚未评估");
        void putLocalMeta(validationMetaKey(targetProfile.key), report).catch((error) => {
          setMessage(error instanceof Error ? `报告已生成，但本机保存失败：${error.message}` : "报告已生成，但本机保存失败");
        });
      };
      worker.onerror = (event) => {
        if (validationRunRef.current !== runId || validationWorkerRef.current !== worker) return;
        finish();
        setMessage(event.message || "正式版验证工作线程失败");
      };
      worker.postMessage({ profile: targetProfile, fixtures: rows, snapshots });
    } catch (error) {
      if (validationRunRef.current !== runId) return;
      setValidationProgress(null);
      setBusy(null);
      setMessage(error instanceof Error ? error.message : "正式版验证启动失败");
    }
  }

  function cancelFormalValidation(): void {
    validationRunRef.current += 1;
    validationWorkerRef.current?.terminate();
    validationWorkerRef.current = null;
    setValidationProgress(null);
    setBusy(null);
    setMessage("正式版验证已取消；上次完整报告未改变");
  }

  async function exportValidationReport(): Promise<void> {
    if (!validationReport || validationStale) {
      setMessage("请先用当前数据完成一次正式版验证");
      return;
    }
    setBusy("validation-export");
    try {
      const safeReport = sanitizeValidationReport(validationReport);
      const contents = JSON.stringify(safeReport, null, 2);
      const date = safeReport.generatedAtUtc.slice(0, 10);
      const name = `liz-validation-${safeReport.profile.shortName.toLowerCase()}-${date}.json`;
      const file = new File([contents], name, { type: "application/json" });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: `${safeReport.profile.shortName} 正式版验证报告`, files: [file] });
      } else {
        download(name, contents);
      }
      setMessage("验证报告已导出；不含 API 密钥与原始比赛数据");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage(error instanceof Error ? error.message : "验证报告导出失败");
    } finally { setBusy(null); }
  }

  async function cachedSquad(key: string, teamId: number): Promise<TeamSquad> {
    const cached = squadCacheRef.current.get(teamId);
    if (cached) return cached;
    const squad = await fetchTeamSquad(key, teamId);
    squadCacheRef.current.set(teamId, squad);
    return squad;
  }

  async function toggleFixtureDetails(row: StoredFixture, force = false): Promise<void> {
    if (row.profileKey !== profile.key) {
      setMessage("比赛与当前赛事不一致，请重新选择赛事");
      return;
    }
    if (!force && expandedFixtureId === row.fixtureId) {
      setExpandedFixtureId(null);
      return;
    }
    setExpandedFixtureId(row.fixtureId);
    const cachedDetail = fixtureDetails[row.fixtureId];
    if (!force && cachedDetail && (cachedDetail.loading || cachedDetail.homeSquad || cachedDetail.awaySquad)) return;
    const detailRun = detailRunRef.current;

    let strength: MatchStrengthIndex | null = null;
    let strengthNote: string | null = null;
    try {
      strength = liz61MatchStrength(makePrediction(profile, row, fixtures));
    } catch (error) {
      strengthNote = error instanceof Error ? error.message : "本机历史不足，暂时无法计算实力指数";
    }
    setFixtureDetails((current) => ({
      ...current,
      [row.fixtureId]: { loading: connected, homeSquad: null, awaySquad: null, strength, strengthNote, squadNote: connected ? "正在读取球队当前名单…" : "连接 API 后可读取球队当前名单" },
    }));
    if (!connected) return;

    try {
      const key = await loadDeviceApiKey();
      const [homeResult, awayResult] = await Promise.allSettled([
        withTimeout(cachedSquad(key, row.homeTeamId)),
        withTimeout(cachedSquad(key, row.awayTeamId)),
      ]);
      const homeSquad = homeResult.status === "fulfilled" ? homeResult.value : null;
      const awaySquad = awayResult.status === "fulfilled" ? awayResult.value : null;
      const failures = [homeResult, awayResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => apiIssueInChinese(result.reason, "球队名单"));
      if (detailRunRef.current !== detailRun) return;
      setFixtureDetails((current) => ({
        ...current,
        [row.fixtureId]: {
          loading: false,
          homeSquad,
          awaySquad,
          strength,
          strengthNote,
          squadNote: failures.length ? `部分名单不可用：${failures.join("；")}` : "当前球队名单，非本场官方首发",
        },
      }));
    } catch (error) {
      if (detailRunRef.current !== detailRun) return;
      setFixtureDetails((current) => ({
        ...current,
        [row.fixtureId]: {
          loading: false,
          homeSquad: null,
          awaySquad: null,
          strength,
          strengthNote,
          squadNote: apiIssueInChinese(error, "球队名单"),
        },
      }));
    }
  }

  async function testCors(): Promise<void> {
    setBusy("test");
    try {
      const key = await loadDeviceApiKey();
      await apiGet(key, "status");
      setMessage("直连测试通过：浏览器可访问 API-Football");
    } catch (error) { setMessage(error instanceof Error ? error.message : "直连测试失败"); }
    finally { setBusy(null); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="logo">L</span><div><strong>Liz 手机版</strong><small>6.1.0-rc.2 · 手机网页版</small></div></div>
        <button className={`connection ${connected ? "on" : ""}`} onClick={() => setTab("settings")}><i />{connected ? "已连接" : "未连接"}</button>
      </header>

      <section className="hero" aria-live="polite">
        <div><span className="eyebrow">设备端工作台</span><h1>18 项赛事，一部手机。</h1><p>{message}</p></div>
        <div className="shield" aria-label="设备加密"><span>◆</span><small>本机</small></div>
      </section>

      {progress && <section className="progress-card"><div><strong>{profile.shortName} {progress.season}</strong><span>{progress.current}/{progress.total}</span></div><progress value={progress.current} max={progress.total} /></section>}

      <section className="competition-block">
        <div className="section-title"><div><span className="eyebrow">赛事配置</span><h2>选择赛事</h2></div><b>{LEAGUE_PROFILES.length}</b></div>
        <div className="competition-strip">
          {LEAGUE_PROFILES.map((item) => <button key={item.key} disabled={!!busy} aria-pressed={item.key === selectedKey} className={item.key === selectedKey ? "active" : ""} style={{ "--accent": item.accent } as React.CSSProperties} onClick={() => setSelectedKey(item.key)}><span>{item.shortName}</span><small>{validationStateText(item.validationState)}</small></button>)}
        </div>
      </section>

      <section className="profile-card" style={{ "--accent": profile.accent } as React.CSSProperties}>
        <div><span className={`state ${profile.validationState.toLowerCase()}`}>{validationStateText(profile.validationState)}</span><h2>{profile.name}</h2><p>{profile.country} · {profile.requiredType === "Cup" ? "杯赛主赛段" : "联赛"} · 90 分钟口径</p></div>
        <div className="stats"><span><b>{completedCount}</b>完赛历史</span><span><b>{upcoming.length}</b>待预测</span><span><b>{quarantineCount}</b>隔离</span></div>
      </section>

      {tab === "matches" && <>
        <section className="toolbar-card">
          <label>赛季<select value={activeSeason} onChange={(event) => setSeason(Number(event.target.value))}>{profile.seasons.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <button className="primary" disabled={!connected || !!busy} onClick={syncSelected}>{busy === "sync" ? "同步中…" : "同步本赛季"}</button>
          <button className="secondary" disabled={!connected || !!busy} onClick={syncAllSeasons}>{busy === "bootstrap" ? "逐季同步中…" : "完整历史"}</button>
        </section>

        {prediction && <PredictionCard value={prediction} onClose={() => setPrediction(null)} />}

        <section className="match-section">
          <div className="section-title"><div><span className="eyebrow">本机赛程</span><h2>未来比赛</h2></div><b>{upcoming.length}</b></div>
          {upcoming.length === 0 ? <div className="empty"><span>◎</span><h3>暂无待赛数据</h3><p>连接 API 后同步所选赛季；完整历史用于模型烧入。</p></div> : <div className="match-list">{upcoming.map((row) => <MatchCard
            key={row.fixtureId}
            row={row}
            expanded={expandedFixtureId === row.fixtureId}
            detail={fixtureDetails[row.fixtureId] ?? null}
            busy={busy}
            onToggle={(force) => toggleFixtureDetails(row, force)}
            onPredict={() => predict(row)}
          />)}</div>}
        </section>
      </>}

      {tab === "history" && <section className="history-section">
        <div className="section-title"><div><span className="eyebrow">设备内保存</span><h2>预测历史</h2></div><b>{visibleHistory.length}</b></div>
        {prediction && <PredictionCard value={prediction} onClose={() => setPrediction(null)} />}
        {visibleHistory.length === 0 ? <div className="empty"><span>◷</span><h3>还没有预测</h3><p>生成的预览与开球前60分钟锁定结果会保存在此设备。</p></div> : visibleHistory.map((item, index) => <button className="history-row" key={typeof item.id === "string" ? item.id : `invalid-${index}`} onClick={() => setPrediction(item)}><div><strong>{typeof item.home === "string" ? item.home : "未知主队"} — {typeof item.away === "string" ? item.away : "未知客队"}</strong><span>{historyTime(item.generatedAtUtc)} · {forecastStateText(item.forecastState)}</span></div><b>{validPredictionVersion(item.versions?.liz61) ? percentage(item.versions.liz61.homeWin) : "旧版"}</b></button>)}
      </section>}

      {tab === "validation" && <ValidationCenter
        profile={profile}
        report={validationReport}
        stale={validationStale}
        loading={validationLoading}
        progress={validationProgress}
        running={busy === "validation"}
        blocked={!!busy && busy !== "validation"}
        onRun={startFormalValidation}
        onCancel={cancelFormalValidation}
        onExport={exportValidationReport}
        onSwitchK1={() => setSelectedKey(RC1_PROFILE_KEY)}
      />}

      {tab === "settings" && <section className="settings-section">
        <div className="section-title"><div><span className="eyebrow">只在此设备</span><h2>安全与备份</h2></div></div>
        <article className="setting-card"><h3>API-Football</h3><p>密钥用浏览器生成的不可导出 AES-GCM 密钥加密；请求直接发往 api-sports.io，GitHub 不接触密钥。</p>{connected ? <div className="connected-panel"><span>● 已连接{plan ? ` · ${plan}` : ""}</span><button disabled={!!busy} onClick={testCors}>测试直连</button></div> : <div className="key-form"><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴新 API 密钥" /><button className="primary" disabled={!!busy} onClick={connect}>{busy === "connect" ? "验证中…" : "验证并保存"}</button></div>}</article>
        <article className="setting-card"><h3>手机桌面安装</h3><p>iPhone：Safari 分享 → 添加到主屏幕。Android：浏览器菜单 → 安装应用。</p>{installPrompt && <button className="secondary" onClick={async () => { await installPrompt.prompt(); setInstallPrompt(null); }}>立即安装</button>}</article>
        <article className="setting-card"><h3>本机备份</h3><p>导出赛程、原始响应快照与预测历史。备份永远不含 API 密钥。</p><div className="button-row"><button className="secondary" disabled={!!busy} onClick={backup}>导出 JSON</button><button className="secondary" disabled={!!busy} onClick={() => importRef.current?.click()}>恢复备份</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && restore(event.target.files[0])} /></div></article>
        <article className="setting-card danger"><h3>清除设备</h3><p>删除本机密钥、赛程、快照和预测；不会更改 API-Football 账户。</p><button onClick={reset}>清除本机数据</button></article>
        <aside className="privacy-note">本站是公开可访问的静态应用外壳，但你的密钥与数据不上传 GitHub。请勿在聊天、截图或代码仓库中粘贴密钥。</aside>
      </section>}

      <nav className="bottom-nav" aria-label="主导航"><button aria-current={tab === "matches" ? "page" : undefined} className={tab === "matches" ? "active" : ""} onClick={() => setTab("matches")}><span aria-hidden="true">⌂</span>比赛</button><button aria-current={tab === "history" ? "page" : undefined} className={tab === "history" ? "active" : ""} onClick={async () => { setTab("history"); setHistory(await predictionHistory(profile.key)); }}><span aria-hidden="true">◷</span>历史</button><button aria-current={tab === "validation" ? "page" : undefined} className={tab === "validation" ? "active" : ""} onClick={() => setTab("validation")}><span aria-hidden="true">✓</span>验证</button><button aria-current={tab === "settings" ? "page" : undefined} className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><span aria-hidden="true">⚙</span>设置</button></nav>
    </main>
  );
}

type MatchCardProps = {
  row: StoredFixture;
  expanded: boolean;
  detail: FixtureDetailState | null;
  busy: string | null;
  onToggle(force?: boolean): void;
  onPredict(): void;
};

function MatchCard({ row, expanded, detail, busy, onToggle, onPredict }: MatchCardProps) {
  const panelId = `match-detail-${row.fixtureId}`;
  return <article className={`match ${expanded ? "expanded" : ""}`}>
    <button className="match-toggle" aria-expanded={expanded} aria-controls={panelId} onClick={() => onToggle()}>
      <span className="match-meta"><span>{kickoff(row.kickoffUtc)}</span><small>{roundInChinese(row.round)}</small></span>
      <span className="teams"><strong>{row.homeTeamName}</strong><i>对阵</i><strong>{row.awayTeamName}</strong></span>
      <span className="expand-copy">{expanded ? "收起比赛详情" : "展开球员与实力详情"}<b aria-hidden="true">{expanded ? "⌃" : "⌄"}</b></span>
    </button>
    {expanded && <section id={panelId} className="fixture-detail" aria-live="polite">
      {!detail ? <p className="detail-status">正在准备比赛详情…</p> : <>
        <section className="strength-card">
          <div className="detail-heading"><div><span>Liz6.1 主线</span><h3>本场对阵实力指数</h3></div><small>主客合计 100</small></div>
          {detail.strength ? <>
            <div className="strength-row"><strong>{detail.strength.home.teamName}</strong><div><i style={{ width: `${detail.strength.home.index}%` }} /></div><b>{detail.strength.home.index.toFixed(1)}</b></div>
            <div className="strength-row away"><strong>{detail.strength.away.teamName}</strong><div><i style={{ width: `${detail.strength.away.index}%` }} /></div><b>{detail.strength.away.index.toFixed(1)}</b></div>
            <p>{detail.strength.explanation}</p>
          </> : <p>{detail.strengthNote ?? "本机历史不足，暂时无法计算实力指数"}</p>}
        </section>

        <section className="squad-card">
          <div className="detail-heading"><div><span>球队当前名单</span><h3>球员信息与身价</h3></div>{detail.loading ? <small>读取中…</small> : <button className="detail-refresh" type="button" onClick={() => onToggle(true)}>重新读取</button>}</div>
          <p className="detail-status">{detail.squadNote}</p>
          {!detail.loading && <div className="squad-columns">
            <SquadPanel fallbackName={row.homeTeamName} squad={detail.homeSquad} />
            <SquadPanel fallbackName={row.awayTeamName} squad={detail.awaySquad} />
          </div>}
          <aside>球员姓名按官方登记显示；API-Football 当前名单接口不提供可靠市场身价，因此统一标为“暂无可靠身价”，不会估算或编造。名单仅供查看，尚未进入当前赛果模型。每支新球队首次展开会消耗一次 API 请求，本次打开期间会缓存。</aside>
        </section>
      </>}
    </section>}
    <button className="predict-button" disabled={!!busy} onClick={onPredict}>{busy === `predict-${row.fixtureId}` ? "正在计算…" : "生成中文分析与研究建议"}</button>
  </article>;
}

function SquadPanel({ fallbackName, squad }: { fallbackName: string; squad: TeamSquad | null }) {
  return <section className="team-squad">
    <div className="squad-title"><h4>{squad?.teamName ?? fallbackName}</h4><span>{squad ? `${squad.players.length} 人` : "暂无名单"}</span></div>
    {squad ? <ul>{squad.players.map((player) => <li key={player.id}>
      <span className="shirt-number">{player.number ?? "—"}</span>
      <span className="player-main"><strong>{player.name}</strong><small>{player.position} · {player.age === null ? "年龄暂无" : `${player.age} 岁`}</small></span>
      <span className="player-value"><small>身价</small><b>暂无可靠数据</b></span>
    </li>)}</ul> : <p className="squad-empty">没有取得该队当前名单。</p>}
  </section>;
}

type ValidationCenterProps = {
  profile: ReturnType<typeof getLeagueProfile>;
  report: ValidationReport | null;
  stale: boolean;
  loading: boolean;
  progress: ValidationProgress | null;
  running: boolean;
  blocked: boolean;
  onRun(): void;
  onCancel(): void;
  onExport(): void;
  onSwitchK1(): void;
};

function validationStatusClass(status: ValidationReport["outcome"]): string {
  return status === "NOT_EVALUATED" ? "not-evaluated" : status.toLowerCase();
}

function validationStatusText(status: ValidationReport["outcome"]): string {
  return ({ PASS: "通过", FAIL: "未通过", BLOCKED: "已阻断", NOT_EVALUATED: "未评估" } as const)[status];
}

function metric(value: number | null): string {
  return value === null ? "—" : value.toFixed(4);
}

function ValidationCenter({ profile, report, stale, loading, progress, running, blocked, onRun, onCancel, onExport, onSwitchK1 }: ValidationCenterProps) {
  const enabled = profile.key === RC1_PROFILE_KEY;
  const progressPercent = progress
    ? progress.phase === "HASHING" ? 96 : progress.total > 0 ? Math.round(progress.processed / progress.total * 92) : 4
    : 0;
  const phaseLabel = progress?.phase === "BACKTESTING" ? "严格滚动回测" : progress?.phase === "HASHING" ? "生成报告指纹" : "检查本机数据";
  const passed = report?.gates.filter((gate) => gate.status === "PASS").length ?? 0;
  const statusCopy = report?.outcome === "BLOCKED"
    ? "历史赔率审计 G10 未完成，固定保持测试阶段"
    : report?.outcome === "PASS"
      ? "全部门槛通过，具备升级候选版条件"
      : report?.outcome === "FAIL" ? "存在未通过门槛，继续保持测试阶段" : "数据不足，仍有门槛尚未评估";
  const models = report ? [report.models.independent, report.models.liz60, report.models.liz61] : [];

  return <section className="validation-section">
    <div className="section-title"><div><span className="eyebrow">6.1.0 候选功能</span><h2>正式版验证中心</h2></div><b>首轮</b></div>
    <article className="validation-intro">
      <div aria-hidden="true">✓</div>
      <section><h3>只验证本机历史</h3><p>运行过程不访问 API、不读取密钥；报告只含汇总指标和数据指纹。</p></section>
    </article>

    {!enabled ? <article className="validation-lock">
      <span aria-hidden="true">◇</span><h3>{profile.shortName} 暂未开放正式验证</h3>
      <p>首批只验收 K1。其他 17 项赛事继续保持观察阶段，待 K1 流程通过后分批开放。</p>
      <button className="secondary" type="button" disabled={blocked || running} onClick={onSwitchK1}>切换到 K1</button>
    </article> : <>
      <div className="validation-actions">
        {running ? <button className="validation-cancel" type="button" onClick={onCancel}>取消验证</button> : <button className="primary" type="button" disabled={blocked || loading} onClick={onRun}>{report && !stale ? "重新运行正式版验证" : "运行正式版验证"}</button>}
        <button className="secondary" type="button" disabled={blocked || running || loading || !report || stale} onClick={onExport}>导出 JSON 报告</button>
      </div>

      {progress && <article className="validation-progress" role="status" aria-live="polite">
        <div><strong>{phaseLabel}</strong><span>{progress.processed}/{progress.total || "—"}</span></div>
        <progress aria-label={phaseLabel} aria-valuetext={`${progressPercent}%`} value={progressPercent} max={100} />
        <p>已评估 {progress.evaluated} 场 · 跳过 {progress.skipped} 场</p>
      </article>}

      {loading ? <div className="validation-loading" role="status">正在核对本机验证报告…</div> : stale ? <article className="validation-summary not-evaluated" aria-live="polite">
        <span>未评估</span><h3>本机数据已变化</h3><p>上次报告与当前赛程或同步快照不一致，请重新运行验证。</p>
      </article> : !report ? <div className="empty validation-empty"><span>✓</span><h3>尚未运行正式版验证</h3><p>建议先在“比赛”页完成 K1 全部赛季同步，再运行验证。</p></div> : <>
        <article className={`validation-summary ${validationStatusClass(report.outcome)}`} aria-live="polite">
          <div><span>{validationStatusText(report.outcome)}</span><small>{passed}/{report.gates.length} 门槛通过</small></div>
          <h3>{statusCopy}</h3>
          <p>生成于 {new Date(report.generatedAtUtc).toLocaleString("zh-CN")} · 样本外 {report.input.evaluatedTargetCount} 场</p>
        </article>

        <section className="validation-results" aria-labelledby="validation-gates-title">
          <div className="validation-subhead"><h3 id="validation-gates-title">发布门槛</h3><span>{report.profile.shortName} · {validationStateText(report.profile.currentState)}</span></div>
          <ul className="validation-gates">
            {report.gates.map((gate) => <li key={gate.id} className={`validation-gate ${validationStatusClass(gate.status)}`}>
              <div><h4>{gate.label}</h4><span className="gate-status">{validationStatusText(gate.status)}</span></div>
              <p className="gate-value">{gate.value}</p>
              <p className="gate-threshold">门槛：{gate.threshold}</p>
              <small>{gate.detail}</small>
            </li>)}
          </ul>
        </section>

        <section className="metrics-card" aria-labelledby="validation-metrics-title">
          <div className="validation-subhead"><h3 id="validation-metrics-title">三模型对照</h3><span>越低越好</span></div>
          <div className="metrics-scroll">
            <table className="metrics-table">
              <caption className="sr-only">独立泊松基线、Liz6.0 与 Liz6.1 回测指标比较</caption>
              <thead><tr><th scope="col">模型</th><th scope="col">场数</th><th scope="col">对数损失</th><th scope="col">布里尔</th><th scope="col">校准误差</th></tr></thead>
              <tbody>{models.map((modelRow) => <tr key={modelRow.modelId} className={modelRow.modelId === "liz61" ? "liz61" : ""}><th scope="row">{modelRow.label}</th><td>{modelRow.evaluated}</td><td>{metric(modelRow.logLoss)}</td><td>{metric(modelRow.brier)}</td><td>{metric(modelRow.ece)}</td></tr>)}</tbody>
            </table>
          </div>
        </section>

        <article className="validation-hashes">
          <h3>审计指纹</h3><p>报告 SHA-256</p><code>{report.reportSha256}</code>
          <p>数据集 SHA-256</p><code>{report.input.datasetSha256}</code>
        </article>
        <aside className="validation-note">历史赔率审计 G10 未通过前，结果固定为“已阻断”且不会升级。报告不含密钥、原始响应或逐场数据。</aside>
      </>}
    </>}
  </section>;
}

function PredictionCard({ value, onClose }: { value: StoredPrediction; onClose(): void }) {
  const guardedAnalysis = isCurrentMatchAnalysis(value.analysis) ? value.analysis : null;
  const validUntilUtc = guardedAnalysis?.value.validUntilUtc ?? null;
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const refresh = () => setNowMs(Date.now());
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    const deadline = validUntilUtc ? Date.parse(validUntilUtc) : Number.NaN;
    const delay = Number.isFinite(deadline) ? Math.max(0, Math.min(deadline - Date.now() + 25, 2_147_000_000)) : null;
    const timer = delay === null ? null : window.setTimeout(refresh, delay);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [value.id, validUntilUtc]);

  const selected = value.versions?.liz61;
  if (!validPredictionRecord(value) || !validPredictionVersion(selected)) return <section className="prediction-card invalid-prediction" role="alert">
    <div className="prediction-head"><div><span>旧版或损坏记录</span><h2>{typeof value.home === "string" ? value.home : "未知主队"} — {typeof value.away === "string" ? value.away : "未知客队"}</h2></div><button aria-label="关闭预测" onClick={onClose}>×</button></div>
    <p>这条记录缺少完整的 Liz6.1 概率契约，已按安全规则阻断文字分析与投注判断。请重新生成预测。</p>
  </section>;
  const analysis = guardedAnalysis;
  const expired = analysis?.value.decision === "RESEARCH_SIGNAL" ? isAnalysisExpired(value, new Date(nowMs)) : false;
  const provenance = value.odds?.provenance;
  const oddsSource = provenance
    ? provenance.bookmakerCount > 0
      ? `API-Football · ${provenance.bookmakerCount} 家公司 · 跨公司中位参考价`
      : `API-Football · ${provenance.detail ?? "未取得可用公司报价"}`
    : "没有可追溯赔率来源";
  return <section className="prediction-card">
    <div className="prediction-head"><div><span>{validationStateText(value.validationState)} · {forecastStateText(value.forecastState)}</span><h2>{value.home} — {value.away}</h2><p>进球均值 {value.homeLambda.toFixed(2)} / {value.awayLambda.toFixed(2)} · 合格历史 {value.eligibleFixtureCount} 场</p></div><button aria-label="关闭预测" onClick={onClose}>×</button></div>
    <div className="outcomes"><span><b>{percentage(selected.homeWin)}</b>主胜</span><span><b>{percentage(selected.draw)}</b>平局</span><span><b>{percentage(selected.awayWin)}</b>客胜</span></div>
    <div className="markets"><span>大 2.5 <b>{percentage(selected.over25)}</b></span><span>双方进球 <b>{percentage(selected.bttsYes)}</b></span></div>
    <div className="scores">{selected.topScores.slice(0, 5).map((score) => <span key={score.score}><b>{score.score}</b>{percentage(score.probability)}</span>)}</div>

    {analysis ? <>
      <article className="match-analysis">
        <div className="analysis-title"><span>本机中文分析</span><b>仅历史赛果</b></div>
        <h3>{analysis.headline}</h3>
        <p>{analysis.sections.modelBasis}</p>
        <p>{analysis.sections.outcome}</p>
        <p>{analysis.sections.goals} {analysis.sections.exactScores}</p>
        <p>{analysis.sections.totals} {analysis.sections.btts}</p>
        <p>{analysis.sections.modelAgreement}</p>
        <aside>{analysis.sections.validationWarning}</aside>
        <small className="data-scope">{analysis.sections.dataScope}</small>
      </article>
      <article className={`betting-advice ${analysis.value.decision === "RESEARCH_SIGNAL" && !expired ? "has-value" : "no-bet"}`}>
        <div className="analysis-title"><span>投注价值研究</span><b>观察阶段</b></div>
        <h3>{expired ? "历史赔率已失效 · 不下注" : analysis.value.decision === "RESEARCH_SIGNAL" ? "发现双模型研究信号 · 暂不执行" : "不下注"}</h3>
        <p className="odds-time">赔率来源：{oddsSource}</p>
        {provenance?.retrievedAtUtc && <p className="odds-time">本机获取：{historyTime(provenance.retrievedAtUtc)}{provenance.providerUpdatedAtUtc ? ` · 数据方更新 ${historyTime(provenance.providerUpdatedAtUtc)}` : ""}</p>}
        {expired ? <p>该赔率快照已超过10分钟或比赛已经开始，历史信号不得作为当前建议。</p> : <p>{analysis.sections.value}</p>}
        {!expired && analysis.value.recommendations.length > 0 && <ul>{analysis.value.recommendations.map((item) => <li key={`${item.market}:${item.selection}`}><strong>{bettingSelectionLabel(item.selection)}</strong><span>参考赔率 {item.decimalOdds.toFixed(2)}</span><span>保守优势 {percentage(item.edge)}</span><span>保守期望值 {percentage(item.expectedValue)}</span><b>Liz6.0 {percentage(item.liz60Probability)} · Liz6.1 {percentage(item.liz61Probability)}</b></li>)}</ul>}
        <p className="stake-note">当前没有可执行仓位：G10 未通过，且参考价不是同一家公司的可成交价格。研究信号最多保留期望值最高的一项。</p>
        <ul className="blocked-reasons">{analysis.value.executionBlockedReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <small className="risk-warning">{analysis.sections.disclaimer}</small>
      </article>
    </> : <article className="analysis-unavailable"><strong>文字分析尚未生成</strong><p>这条历史记录来自旧版本；重新生成预测后会加入基于 Liz6.0 与 Liz6.1 的中文分析。旧版投注判断不会继续使用。</p></article>}

    <details><summary>三版本对照</summary>{Object.entries(value.versions).filter(([, item]) => validPredictionVersion(item)).map(([id, item]) => <p key={id}><strong>{modelVersionText(id)}</strong><span>{percentage(item.homeWin)} / {percentage(item.draw)} / {percentage(item.awayWin)}</span></p>)}</details>
  </section>;
}
