const DB_NAME = "liz-mobile-device-vault";
const STORE = "crypto-keys";
const KEY_ID = "api-football-aes-gcm-v1";
const CIPHER_KEY = "liz-mobile:api-football:v1";

type StoredCiphertext = { version: 1; iv: string; ciphertext: string };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function openVault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开设备保险箱"));
  });
}

async function readKey(): Promise<CryptoKey | null> {
  const db = await openVault();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID);
      request.onsuccess = () => {
        const value = request.result as CryptoKey | undefined;
        resolve(value && value.type === "secret" ? value : null);
      };
      request.onerror = () => reject(request.error ?? new Error("设备密钥读取失败"));
    });
  } finally {
    db.close();
  }
}

async function writeKey(key: CryptoKey): Promise<void> {
  const db = await openVault();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(key, KEY_ID);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("设备密钥保存失败"));
    });
  } finally {
    db.close();
  }
}

export async function saveDeviceApiKey(apiKey: string): Promise<void> {
  if (!globalThis.isSecureContext || !crypto?.subtle || !indexedDB) throw new Error("当前浏览器无法建立安全设备保险箱");
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await writeKey(key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(apiKey));
  const stored: StoredCiphertext = { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
  localStorage.setItem(CIPHER_KEY, JSON.stringify(stored));
}

export async function loadDeviceApiKey(): Promise<string> {
  const raw = localStorage.getItem(CIPHER_KEY);
  if (!raw) throw new Error("请先在设置中连接 API-Football");
  let stored: StoredCiphertext;
  try { stored = JSON.parse(raw) as StoredCiphertext; } catch { throw new Error("设备保险箱数据已损坏，请重新连接"); }
  if (stored.version !== 1 || !stored.iv || !stored.ciphertext) throw new Error("设备保险箱版本无效，请重新连接");
  const key = await readKey();
  if (!key) throw new Error("设备密钥已丢失，请重新连接");
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(stored.iv), tagLength: 128 }, key, fromBase64(stored.ciphertext));
    return new TextDecoder("utf-8", { fatal: true }).decode(decrypted);
  } catch {
    throw new Error("设备保险箱校验失败，请重新连接");
  }
}

export async function hasDeviceApiKey(): Promise<boolean> {
  try { return (await loadDeviceApiKey()).length >= 12; } catch { return false; }
}

export async function clearDeviceApiKey(): Promise<void> {
  localStorage.removeItem(CIPHER_KEY);
  const db = await openVault();
  try {
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(KEY_ID);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
  } finally { db.close(); }
}
