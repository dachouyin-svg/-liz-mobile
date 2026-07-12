import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, fetchFixtureById, fetchSeasonFixtures, validateApiKey } from "./api-football";
import { clearDeviceApiKey, hasDeviceApiKey, loadDeviceApiKey, saveDeviceApiKey } from "./device-key-vault";
import { getLeagueProfile, LEAGUE_PROFILES } from "./league-profiles";
import { makePrediction } from "./model";
import {
  clearLocalData,
  exportLocalData,
  fixturesForProfile,
  importLocalData,
  predictionHistory,
  putFixtures,
  putPrediction,
  putSnapshot,
  type StoredFixture,
  type StoredPrediction,
} from "./storage";

type Tab = "matches" | "history" | "settings";
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

function percentage(value: number): string { return `${(value * 100).toFixed(1)}%`; }

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
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const upcoming = useMemo(() => fixtures.filter((row) => row.statusShort === "NS" && row.scope === "IN_SCOPE" && row.timestamp * 1000 > Date.now()).slice(0, 40), [fixtures]);
  const completedCount = useMemo(() => fixtures.filter((row) => row.homeGoals90 !== null && row.scope === "IN_SCOPE").length, [fixtures]);
  const quarantineCount = useMemo(() => fixtures.filter((row) => row.scope === "QUARANTINE").length, [fixtures]);

  async function reloadProfile(key = selectedKey): Promise<void> {
    const [rows, predictions] = await Promise.all([fixturesForProfile(key), predictionHistory(key)]);
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
    reloadProfile(profile.key).catch((error) => setMessage(error instanceof Error ? error.message : "本机数据读取失败"));
  }, [profile.key]);

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

  async function syncOne(targetSeason: number, key: string): Promise<number> {
    const result = await fetchSeasonFixtures(key, profile, targetSeason);
    await putFixtures(result.fixtures);
    await putSnapshot({
      id: `${profile.key}:${targetSeason}:${Date.now()}`,
      profileKey: profile.key,
      season: targetSeason,
      capturedAtUtc: new Date().toISOString(),
      providerLeagueId: result.resolved.providerLeagueId,
      fixtureCount: result.fixtures.length,
      payload: result.raw,
    });
    return result.fixtures.length;
  }

  async function syncSelected(): Promise<void> {
    setBusy("sync");
    setProgress({ current: 0, total: 1, season });
    try {
      const key = await loadDeviceApiKey();
      const count = await syncOne(season, key);
      await reloadProfile();
      setMessage(`${profile.shortName} ${season} 同步完成：${count} 场`);
      setProgress({ current: 1, total: 1, season });
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
      }
      setMessage(`${profile.shortName} 历史同步完成：${totalFixtures} 场，本机共 ${profile.seasons.length} 个赛季`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "历史同步失败"); }
    finally { setBusy(null); setTimeout(() => setProgress(null), 1400); }
  }

  async function predict(row: StoredFixture): Promise<void> {
    setBusy(`predict-${row.fixtureId}`);
    try {
      const key = await loadDeviceApiKey();
      const live = await fetchFixtureById(key, profile, row.season, row.fixtureId);
      await putFixtures([live]);
      const rows = await fixturesForProfile(profile.key);
      const result = makePrediction(profile, live, rows);
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
      setMessage(`恢复完成：${result.fixtures} 场赛程，${result.predictions} 条预测，${result.snapshots} 个快照`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "恢复失败"); }
    finally { setBusy(null); if (importRef.current) importRef.current.value = ""; }
  }

  async function reset(): Promise<void> {
    if (!window.confirm("清除这台设备上的 API 密钥、赛程、快照和预测历史？此操作无法撤销。")) return;
    await Promise.all([clearDeviceApiKey(), clearLocalData()]);
    setConnected(false); setPlan(null); setFixtures([]); setHistory([]); setPrediction(null); setMessage("本机数据已清除");
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
        <div className="brand"><span className="logo">L</span><div><strong>Liz Mobile</strong><small>6.1.0a4 · GitHub Pages</small></div></div>
        <button className={`connection ${connected ? "on" : ""}`} onClick={() => setTab("settings")}><i />{connected ? "已连接" : "未连接"}</button>
      </header>

      <section className="hero">
        <div><span className="eyebrow">设备端工作台</span><h1>18 项赛事，一部手机。</h1><p>{message}</p></div>
        <div className="shield" aria-label="设备加密"><span>◆</span><small>LOCAL</small></div>
      </section>

      {progress && <section className="progress-card"><div><strong>{profile.shortName} {progress.season}</strong><span>{progress.current}/{progress.total}</span></div><progress value={progress.current} max={progress.total} /></section>}

      <section className="competition-block">
        <div className="section-title"><div><span className="eyebrow">赛事配置</span><h2>选择赛事</h2></div><b>{LEAGUE_PROFILES.length}</b></div>
        <div className="competition-strip">
          {LEAGUE_PROFILES.map((item) => <button key={item.key} className={item.key === selectedKey ? "active" : ""} style={{ "--accent": item.accent } as React.CSSProperties} onClick={() => setSelectedKey(item.key)}><span>{item.shortName}</span><small>{item.validationState}</small></button>)}
        </div>
      </section>

      <section className="profile-card" style={{ "--accent": profile.accent } as React.CSSProperties}>
        <div><span className={`state ${profile.validationState.toLowerCase()}`}>{profile.validationState}</span><h2>{profile.name}</h2><p>{profile.country} · {profile.requiredType === "Cup" ? "杯赛主赛段" : "联赛"} · 90 分钟口径</p></div>
        <div className="stats"><span><b>{completedCount}</b>完赛历史</span><span><b>{upcoming.length}</b>待预测</span><span><b>{quarantineCount}</b>隔离</span></div>
      </section>

      {tab === "matches" && <>
        <section className="toolbar-card">
          <label>赛季<select value={season} onChange={(event) => setSeason(Number(event.target.value))}>{profile.seasons.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <button className="primary" disabled={!connected || !!busy} onClick={syncSelected}>{busy === "sync" ? "同步中…" : "同步本赛季"}</button>
          <button className="secondary" disabled={!connected || !!busy} onClick={syncAllSeasons}>{busy === "bootstrap" ? "逐季同步中…" : "完整历史"}</button>
        </section>

        {prediction && <PredictionCard value={prediction} onClose={() => setPrediction(null)} />}

        <section className="match-section">
          <div className="section-title"><div><span className="eyebrow">本机赛程</span><h2>未来比赛</h2></div><b>{upcoming.length}</b></div>
          {upcoming.length === 0 ? <div className="empty"><span>◎</span><h3>暂无待赛数据</h3><p>连接 API 后同步所选赛季；完整历史用于模型烧入。</p></div> : <div className="match-list">{upcoming.map((row) => <article className="match" key={row.fixtureId}><div className="match-meta"><span>{kickoff(row.kickoffUtc)}</span><small>{row.round}</small></div><div className="teams"><strong>{row.homeTeamName}</strong><i>VS</i><strong>{row.awayTeamName}</strong></div><button disabled={!!busy} onClick={() => predict(row)}>{busy === `predict-${row.fixtureId}` ? "计算中…" : "生成预测"}</button></article>)}</div>}
        </section>
      </>}

      {tab === "history" && <section className="history-section">
        <div className="section-title"><div><span className="eyebrow">设备内保存</span><h2>预测历史</h2></div><b>{history.length}</b></div>
        {history.length === 0 ? <div className="empty"><span>◷</span><h3>还没有预测</h3><p>生成的预览与 T−60 锁定结果会保存在此设备。</p></div> : history.map((item) => <button className="history-row" key={item.id} onClick={() => setPrediction(item)}><div><strong>{item.home} — {item.away}</strong><span>{new Date(item.generatedAtUtc).toLocaleString("zh-CN")} · {item.forecastState}</span></div><b>{percentage(item.versions.liz61.homeWin)}</b></button>)}
        {prediction && <PredictionCard value={prediction} onClose={() => setPrediction(null)} />}
      </section>}

      {tab === "settings" && <section className="settings-section">
        <div className="section-title"><div><span className="eyebrow">只在此设备</span><h2>安全与备份</h2></div></div>
        <article className="setting-card"><h3>API-Football</h3><p>密钥用浏览器生成的不可导出 AES-GCM 密钥加密；请求直接发往 api-sports.io，GitHub 不接触密钥。</p>{connected ? <div className="connected-panel"><span>● 已连接{plan ? ` · ${plan}` : ""}</span><button disabled={!!busy} onClick={testCors}>测试直连</button></div> : <div className="key-form"><input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴新 API 密钥" /><button className="primary" disabled={!!busy} onClick={connect}>{busy === "connect" ? "验证中…" : "验证并保存"}</button></div>}</article>
        <article className="setting-card"><h3>手机桌面安装</h3><p>iPhone：Safari 分享 → 添加到主屏幕。Android：浏览器菜单 → 安装应用。</p>{installPrompt && <button className="secondary" onClick={async () => { await installPrompt.prompt(); setInstallPrompt(null); }}>立即安装</button>}</article>
        <article className="setting-card"><h3>本机备份</h3><p>导出赛程、原始响应快照与预测历史。备份永远不含 API 密钥。</p><div className="button-row"><button className="secondary" disabled={!!busy} onClick={backup}>导出 JSON</button><button className="secondary" disabled={!!busy} onClick={() => importRef.current?.click()}>恢复备份</button><input ref={importRef} hidden type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && restore(event.target.files[0])} /></div></article>
        <article className="setting-card danger"><h3>清除设备</h3><p>删除本机密钥、赛程、快照和预测；不会更改 API-Football 账户。</p><button onClick={reset}>清除本机数据</button></article>
        <aside className="privacy-note">本站是公开可访问的静态应用外壳，但你的密钥与数据不上传 GitHub。请勿在聊天、截图或代码仓库中粘贴密钥。</aside>
      </section>}

      <nav className="bottom-nav"><button className={tab === "matches" ? "active" : ""} onClick={() => setTab("matches")}><span>⌂</span>比赛</button><button className={tab === "history" ? "active" : ""} onClick={async () => { setTab("history"); setHistory(await predictionHistory(profile.key)); }}><span>◷</span>历史</button><button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><span>⚙</span>设置</button></nav>
    </main>
  );
}

function PredictionCard({ value, onClose }: { value: StoredPrediction; onClose(): void }) {
  const selected = value.versions.liz61;
  return <section className="prediction-card"><div className="prediction-head"><div><span>{value.validationState} · {value.forecastState}</span><h2>{value.home} — {value.away}</h2><p>λ {value.homeLambda.toFixed(2)} / {value.awayLambda.toFixed(2)} · 历史 {value.eligibleFixtureCount} 场</p></div><button onClick={onClose}>×</button></div><div className="outcomes"><span><b>{percentage(selected.homeWin)}</b>主胜</span><span><b>{percentage(selected.draw)}</b>平局</span><span><b>{percentage(selected.awayWin)}</b>客胜</span></div><div className="markets"><span>大 2.5 <b>{percentage(selected.over25)}</b></span><span>双方进球 <b>{percentage(selected.bttsYes)}</b></span></div><div className="scores">{selected.topScores.slice(0, 5).map((score) => <span key={score.score}><b>{score.score}</b>{percentage(score.probability)}</span>)}</div><details><summary>三版本对照</summary>{Object.entries(value.versions).map(([id, item]) => <p key={id}><strong>{id}</strong><span>{percentage(item.homeWin)} / {percentage(item.draw)} / {percentage(item.awayWin)}</span></p>)}</details></section>;
}
