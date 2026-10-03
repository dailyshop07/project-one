import type { SyncOperation } from "../types";

const cryptoVersion = 1 as const;
const keySalt = new TextEncoder().encode("project-one-cloudflare-sync-key-v1");

export type EncryptedPayload = {
  version: typeof cryptoVersion;
  iv: string;
  ciphertext: string;
};

export type SyncCipher = {
  available: boolean;
  encryptOperation: (eventId: string, operation: SyncOperation) => Promise<{ encrypted: boolean; payload: string }>;
  decryptOperation: (eventId: string, encrypted: boolean, payload: string) => Promise<SyncOperation>;
  encryptCheckpoint: (baseSequence: number, operations: SyncOperation[]) => Promise<string>;
  decryptCheckpoint: (payload: string) => Promise<{ baseSequence: number; operations: SyncOperation[] }>;
};

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

const fromBase64Url = (value: string) => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const textBytes = (value: string) => new TextEncoder().encode(value);
const textFromBytes = (value: ArrayBuffer | Uint8Array) => new TextDecoder().decode(value);

async function deriveKey(secret: string) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const material = await subtle.importKey("raw", textBytes(secret), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", salt: keySalt, iterations: 120_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptJson(key: CryptoKey | undefined, associatedData: string, value: unknown) {
  if (!key || !globalThis.crypto?.subtle) return { encrypted: false, payload: JSON.stringify(value) };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: textBytes(associatedData) },
    key,
    textBytes(JSON.stringify(value)),
  );
  const envelope: EncryptedPayload = { version: cryptoVersion, iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
  return { encrypted: true, payload: JSON.stringify(envelope) };
}

async function decryptJson<T>(key: CryptoKey | undefined, associatedData: string, encrypted: boolean, payload: string): Promise<T> {
  if (!encrypted) return JSON.parse(payload) as T;
  if (!key || !globalThis.crypto?.subtle) throw new Error("同步加密不可用，无法读取服务器事件");
  const envelope = JSON.parse(payload) as Partial<EncryptedPayload>;
  if (envelope.version !== cryptoVersion || typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") throw new Error("同步事件加密格式无效");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv), additionalData: textBytes(associatedData) },
    key,
    fromBase64Url(envelope.ciphertext),
  );
  return JSON.parse(textFromBytes(plaintext)) as T;
}

export async function createSyncCipher(secret: string): Promise<SyncCipher> {
  const key = await deriveKey(secret);
  return {
    available: Boolean(key),
    encryptOperation: (eventId, operation) => encryptJson(key, eventId, operation),
    decryptOperation: (eventId, encrypted, payload) => decryptJson<SyncOperation>(key, eventId, encrypted, payload),
    encryptCheckpoint: async (baseSequence, operations) => {
      const result = await encryptJson(key, "checkpoint", { version: cryptoVersion, baseSequence, operations });
      return result.payload;
    },
    decryptCheckpoint: async (payload) => {
      const value = await decryptJson<{ version?: number; baseSequence: number; operations: SyncOperation[] }>(key, "checkpoint", Boolean(key), payload);
      return { baseSequence: value.baseSequence, operations: value.operations };
    },
  };
}

export const splitCiphertext = (payload: string, chunkSize = 48_000) =>
  Array.from({ length: Math.max(1, Math.ceil(payload.length / chunkSize)) }, (_, index) => payload.slice(index * chunkSize, (index + 1) * chunkSize));
