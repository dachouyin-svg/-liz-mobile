import { isCurrentMatchAnalysis, type MatchAnalysis, type NormalizedOddsInput } from "./match-analysis";

export type StoredFixture = {
  fixtureId: number;
  profileKey: string;
  season: number;
  kickoffUtc: string;
  timestamp: number;
  statusShort: string;
  round: string;
  scope: "IN_SCOPE" | "EXCLUDED" | "QUARANTINE";
  homeTeamId: number;
  awayTeamId: number;
  homeTeamName: string;
  awayTeamName: string;
  homeGoals90: number | null;
  awayGoals90: number | null;
  syncedAtUtc: string;
};

export type StoredPrediction = {
  id: string;
  fixtureId: number;
  profileKey: string;
  generatedAtUtc: string;
  kickoffUtc: string;
  home: string;
  away: string;
  forecastState: "PREVIEW" | "T60_LOCKED";
  validationState: "SHADOW" | "ALPHA" | "RC" | "STABLE";
  homeLambda: number;
  awayLambda: number;
  eligibleFixtureCount: number;
  odds?: NormalizedOddsInput;
  oddsCapturedAtUtc?: string;
  analysis?: MatchAnalysis;
  versions: Record<string, {
    homeWin: number;
    draw: number;
    awayWin: number;
    over25: number;
    bttsYes: number;
    topScores: Array<{ score: string; probability: number }>;
  }>;
};

export type SyncSnapshot = {
  id: string;
  profileKey: string;
  season: number;
  capturedAtUtc: string;
  providerLeagueId: number;
  providerName?: string;
  providerCountry?: string;
  fixtureCount: number;
  payload: unknown;
};

export type SyncSnapshotMeta = Omit<SyncSnapshot, "payload">;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.normalize("NFKC").trim());
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function predictionVersionRecord(value: unknown): boolean {
  const row = record(value);
  if (!row || ![row.homeWin, row.draw, row.awayWin, row.over25, row.bttsYes].every(probability)) return false;
  if (Math.abs((row.homeWin as number) + (row.draw as number) + (row.awayWin as number) - 1) > 1e-6 || !Array.isArray(row.topScores)) return false;
  return row.topScores.every((item) => {
    const score = record(item);
    return Boolean(score && nonEmptyText(score.score) && probability(score.probability));
  });
}

function oddsRecord(value: unknown): boolean {
  if (value === undefined) return true;
  const row = record(value);
  if (!row) return false;
  const market = (candidate: unknown, keys: readonly string[]): boolean => {
    if (candidate === undefined) return true;
    const values = record(candidate);
    return Boolean(values && keys.every((key) => typeof values[key] === "number" && Number.isFinite(values[key]) && (values[key] as number) > 1));
  };
  if (!market(row.oneXTwo, ["home", "draw", "away"]) || !market(row.overUnder25, ["over", "under"]) || !market(row.btts, ["yes", "no"])) return false;
  if (row.provenance === undefined) return true;
  const source = record(row.provenance);
  return Boolean(source
    && source.source === "API_FOOTBALL"
    && ["OK", "PARTIAL", "NO_MARKET", "ERROR"].includes(String(source.status))
    && validDate(source.retrievedAtUtc)
    && (source.providerUpdatedAtUtc === null || validDate(source.providerUpdatedAtUtc))
    && nonNegativeInteger(source.bookmakerCount)
    && Array.isArray(source.bookmakerNames) && source.bookmakerNames.every(nonEmptyText)
    && source.pricingMethod === "CROSS_BOOKMAKER_MEDIAN"
    && source.actionable === false);
}

export function isStoredFixtureRecord(value: unknown): value is StoredFixture {
  const row = record(value);
  return Boolean(row
    && positiveInteger(row.fixtureId)
    && nonEmptyText(row.profileKey)
    && positiveInteger(row.season)
    && validDate(row.kickoffUtc)
    && positiveInteger(row.timestamp)
    && nonEmptyText(row.statusShort)
    && typeof row.round === "string"
    && ["IN_SCOPE", "EXCLUDED", "QUARANTINE"].includes(String(row.scope))
    && positiveInteger(row.homeTeamId) && positiveInteger(row.awayTeamId)
    && nonEmptyText(row.homeTeamName) && nonEmptyText(row.awayTeamName)
    && (row.homeGoals90 === null || nonNegativeInteger(row.homeGoals90))
    && (row.awayGoals90 === null || nonNegativeInteger(row.awayGoals90))
    && validDate(row.syncedAtUtc));
}

export function isStoredPredictionRecord(value: unknown): value is StoredPrediction {
  const row = record(value);
  const versions = row ? record(row.versions) : null;
  return Boolean(row
    && nonEmptyText(row.id)
    && positiveInteger(row.fixtureId)
    && nonEmptyText(row.profileKey)
    && validDate(row.generatedAtUtc) && validDate(row.kickoffUtc)
    && nonEmptyText(row.home) && nonEmptyText(row.away)
    && ["PREVIEW", "T60_LOCKED"].includes(String(row.forecastState))
    && ["SHADOW", "ALPHA", "RC", "STABLE"].includes(String(row.validationState))
    && typeof row.homeLambda === "number" && Number.isFinite(row.homeLambda) && row.homeLambda > 0
    && typeof row.awayLambda === "number" && Number.isFinite(row.awayLambda) && row.awayLambda > 0
    && nonNegativeInteger(row.eligibleFixtureCount)
    && versions
    && predictionVersionRecord(versions.independent)
    && predictionVersionRecord(versions.liz60)
    && predictionVersionRecord(versions.liz61)
    && oddsRecord(row.odds)
    && (row.oddsCapturedAtUtc === undefined || validDate(row.oddsCapturedAtUtc)));
}

export function isSyncSnapshotRecord(value: unknown): value is SyncSnapshot {
  const row = record(value);
  return Boolean(row
    && nonEmptyText(row.id) && nonEmptyText(row.profileKey)
    && positiveInteger(row.season) && validDate(row.capturedAtUtc)
    && positiveInteger(row.providerLeagueId)
    && (row.providerName === undefined || nonEmptyText(row.providerName))
    && (row.providerCountry === undefined || nonEmptyText(row.providerCountry))
    && nonNegativeInteger(row.fixtureCount)
    && Object.prototype.hasOwnProperty.call(row, "payload"));
}

const DB_NAME = "liz-mobile-data-v1";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("fixtures")) {
        const store = db.createObjectStore("fixtures", { keyPath: "fixtureId" });
        store.createIndex("profileKey", "profileKey");
      }
      if (!db.objectStoreNames.contains("predictions")) {
        const store = db.createObjectStore("predictions", { keyPath: "id" });
        store.createIndex("profileKey", "profileKey");
        store.createIndex("generatedAtUtc", "generatedAtUtc");
      }
      if (!db.objectStoreNames.contains("snapshots")) {
        const store = db.createObjectStore("snapshots", { keyPath: "id" });
        store.createIndex("profileKey", "profileKey");
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本机数据库"));
  });
}

export async function putFixtures(rows: readonly StoredFixture[]): Promise<void> {
  if (!rows.length) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("fixtures", "readwrite");
      const store = transaction.objectStore("fixtures");
      for (const row of rows) store.put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("保存赛程失败"));
    });
  } finally { db.close(); }
}

export async function replaceSeasonFixtures(
  profileKey: string,
  season: number,
  rows: readonly StoredFixture[],
): Promise<void> {
  if (rows.some((row) => row.profileKey !== profileKey || row.season !== season)) {
    throw new Error("赛季替换数据与目标赛事不一致");
  }
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("fixtures", "readwrite");
      const store = transaction.objectStore("fixtures");
      const cursorRequest = store.index("profileKey").openCursor(profileKey);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          if ((cursor.value as StoredFixture).season === season) cursor.delete();
          cursor.continue();
          return;
        }
        for (const row of rows) store.put(row);
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("替换赛季数据失败"));
    });
  } finally { db.close(); }
}

function readAllByIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
  return openDb().then((db) => new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).index(indexName).getAll(key);
    request.onsuccess = () => { db.close(); resolve(request.result as T[]); };
    request.onerror = () => { db.close(); reject(request.error ?? new Error("读取本机数据失败")); };
  }));
}

export async function fixturesForProfile(profileKey: string): Promise<StoredFixture[]> {
  const rows = await readAllByIndex<StoredFixture>("fixtures", "profileKey", profileKey);
  return rows.filter(isStoredFixtureRecord).sort((a, b) => a.timestamp - b.timestamp || a.fixtureId - b.fixtureId);
}

export async function syncSnapshotsForProfile(profileKey: string): Promise<SyncSnapshotMeta[]> {
  const rows = await readAllByIndex<SyncSnapshot>("snapshots", "profileKey", profileKey);
  return rows
    .filter(isSyncSnapshotRecord)
    .map((row) => ({
      id: row.id,
      profileKey: row.profileKey,
      season: row.season,
      capturedAtUtc: row.capturedAtUtc,
      providerLeagueId: row.providerLeagueId,
      providerName: row.providerName,
      providerCountry: row.providerCountry,
      fixtureCount: row.fixtureCount,
    }))
    .sort((left, right) => left.capturedAtUtc.localeCompare(right.capturedAtUtc));
}

export async function fixtureById(fixtureId: number): Promise<StoredFixture | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("fixtures", "readonly").objectStore("fixtures").get(fixtureId);
      request.onsuccess = () => resolve((request.result as StoredFixture | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("读取赛程失败"));
    });
  } finally { db.close(); }
}

export async function putLocalMeta<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("meta", "readwrite");
      transaction.objectStore("meta").put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("保存本机状态失败"));
    });
  } finally { db.close(); }
}

export async function getLocalMeta<T>(key: string): Promise<T | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("meta", "readonly").objectStore("meta").get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("读取本机状态失败"));
    });
  } finally { db.close(); }
}

export async function deleteLocalMeta(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("meta", "readwrite");
      transaction.objectStore("meta").delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("删除本机状态失败"));
    });
  } finally { db.close(); }
}

export async function putSnapshot(snapshot: SyncSnapshot): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("snapshots", "readwrite");
      transaction.objectStore("snapshots").put(snapshot);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("保存快照失败"));
    });
  } finally { db.close(); }
}

export async function putPrediction(prediction: StoredPrediction): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("predictions", "readwrite");
      transaction.objectStore("predictions").put(prediction);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("保存预测失败"));
    });
  } finally { db.close(); }
}

export async function predictionHistory(profileKey?: string): Promise<StoredPrediction[]> {
  let rows: StoredPrediction[];
  if (profileKey) rows = await readAllByIndex<StoredPrediction>("predictions", "profileKey", profileKey);
  else {
    const db = await openDb();
    try {
      rows = await new Promise((resolve, reject) => {
        const request = db.transaction("predictions", "readonly").objectStore("predictions").getAll();
        request.onsuccess = () => resolve(request.result as StoredPrediction[]);
        request.onerror = () => reject(request.error ?? new Error("读取预测历史失败"));
      });
    } finally { db.close(); }
  }
  return rows
    .filter(isStoredPredictionRecord)
    .sort((a, b) => Date.parse(b.generatedAtUtc) - Date.parse(a.generatedAtUtc));
}

export async function clearLocalData(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["fixtures", "predictions", "snapshots", "meta"], "readwrite");
      for (const name of ["fixtures", "predictions", "snapshots", "meta"]) transaction.objectStore(name).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("清除本机数据失败"));
    });
  } finally { db.close(); }
}

export type LizBackup = {
  schema: "liz-mobile-backup-v1";
  exportedAtUtc: string;
  fixtures: StoredFixture[];
  predictions: StoredPrediction[];
  snapshots: SyncSnapshot[];
};

async function allRows<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new Error("读取备份数据失败"));
    });
  } finally { db.close(); }
}

export async function exportLocalData(): Promise<LizBackup> {
  const [fixtureRows, predictionRows, snapshotRows] = await Promise.all([
    allRows<StoredFixture>("fixtures"),
    allRows<StoredPrediction>("predictions"),
    allRows<SyncSnapshot>("snapshots"),
  ]);
  const fixtures = fixtureRows.filter(isStoredFixtureRecord);
  const predictions = predictionRows.filter(isStoredPredictionRecord);
  const snapshots = snapshotRows.filter(isSyncSnapshotRecord);
  return { schema: "liz-mobile-backup-v1", exportedAtUtc: new Date().toISOString(), fixtures, predictions, snapshots };
}

function uniqueBy<T>(rows: readonly T[], key: (row: T) => string | number, label: string): void {
  const values = new Set<string | number>();
  for (const row of rows) {
    const value = key(row);
    if (values.has(value)) throw new Error(`备份包含重复的${label}`);
    values.add(value);
  }
}

export function parseLizBackup(value: unknown): LizBackup {
  const root = record(value);
  if (!root || root.schema !== "liz-mobile-backup-v1") throw new Error("不是 Liz 手机版 v1 备份");
  if (!validDate(root.exportedAtUtc) || !Array.isArray(root.fixtures) || !Array.isArray(root.predictions) || !Array.isArray(root.snapshots)) throw new Error("备份结构不完整");
  if (!root.fixtures.every(isStoredFixtureRecord)) throw new Error("备份包含无效赛程，未导入任何数据");
  if (!root.predictions.every(isStoredPredictionRecord)) throw new Error("备份包含无效预测，未导入任何数据");
  if (!root.snapshots.every(isSyncSnapshotRecord)) throw new Error("备份包含无效同步快照，未导入任何数据");

  const fixtures = root.fixtures as StoredFixture[];
  const snapshots = root.snapshots as SyncSnapshot[];
  const predictions = (root.predictions as StoredPrediction[]).map((row) => {
    if (row.analysis === undefined) return row;
    if (isCurrentMatchAnalysis(row.analysis)) {
      if (row.analysis.fixtureId !== row.fixtureId || row.analysis.generatedAtUtc !== row.generatedAtUtc) {
        throw new Error("备份中的文字分析与预测记录不一致，未导入任何数据");
      }
      return row;
    }
    const legacy = record(row.analysis);
    if (legacy?.schema !== "liz-match-analysis-v1") throw new Error("备份包含损坏的文字分析，未导入任何数据");
    const { analysis: ignoredAnalysis, ...withoutLegacyAnalysis } = row;
    void ignoredAnalysis;
    return withoutLegacyAnalysis as StoredPrediction;
  });
  uniqueBy(fixtures, (row) => row.fixtureId, "比赛编号");
  uniqueBy(predictions, (row) => row.id, "预测编号");
  uniqueBy(snapshots, (row) => row.id, "快照编号");
  return {
    schema: "liz-mobile-backup-v1",
    exportedAtUtc: root.exportedAtUtc as string,
    fixtures,
    predictions,
    snapshots,
  };
}

export async function importLocalData(value: unknown): Promise<{ fixtures: number; predictions: number; snapshots: number }> {
  const backup = parseLizBackup(value);
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["fixtures", "predictions", "snapshots"], "readwrite");
      const fixtures = transaction.objectStore("fixtures");
      const predictions = transaction.objectStore("predictions");
      const snapshots = transaction.objectStore("snapshots");
      for (const row of backup.fixtures) fixtures.put(row);
      for (const row of backup.predictions) predictions.put(row);
      for (const row of backup.snapshots) snapshots.put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("导入备份失败"));
      transaction.onabort = () => reject(transaction.error ?? new Error("导入备份已取消"));
    });
  } finally { db.close(); }
  return { fixtures: backup.fixtures.length, predictions: backup.predictions.length, snapshots: backup.snapshots.length };
}
