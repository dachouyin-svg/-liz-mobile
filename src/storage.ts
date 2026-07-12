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
  validationState: "ALPHA" | "SHADOW";
  homeLambda: number;
  awayLambda: number;
  eligibleFixtureCount: number;
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
  fixtureCount: number;
  payload: unknown;
};

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

function readAllByIndex<T>(storeName: string, indexName: string, key: IDBValidKey): Promise<T[]> {
  return openDb().then((db) => new Promise<T[]>((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).index(indexName).getAll(key);
    request.onsuccess = () => { db.close(); resolve(request.result as T[]); };
    request.onerror = () => { db.close(); reject(request.error ?? new Error("读取本机数据失败")); };
  }));
}

export async function fixturesForProfile(profileKey: string): Promise<StoredFixture[]> {
  const rows = await readAllByIndex<StoredFixture>("fixtures", "profileKey", profileKey);
  return rows.sort((a, b) => a.timestamp - b.timestamp || a.fixtureId - b.fixtureId);
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
  return rows.sort((a, b) => b.generatedAtUtc.localeCompare(a.generatedAtUtc));
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
  const [fixtures, predictions, snapshots] = await Promise.all([
    allRows<StoredFixture>("fixtures"),
    allRows<StoredPrediction>("predictions"),
    allRows<SyncSnapshot>("snapshots"),
  ]);
  return { schema: "liz-mobile-backup-v1", exportedAtUtc: new Date().toISOString(), fixtures, predictions, snapshots };
}

export async function importLocalData(value: unknown): Promise<{ fixtures: number; predictions: number; snapshots: number }> {
  if (!value || typeof value !== "object" || (value as Partial<LizBackup>).schema !== "liz-mobile-backup-v1") throw new Error("不是 Liz Mobile v1 备份");
  const backup = value as LizBackup;
  if (!Array.isArray(backup.fixtures) || !Array.isArray(backup.predictions) || !Array.isArray(backup.snapshots)) throw new Error("备份结构不完整");
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
    });
  } finally { db.close(); }
  return { fixtures: backup.fixtures.length, predictions: backup.predictions.length, snapshots: backup.snapshots.length };
}
