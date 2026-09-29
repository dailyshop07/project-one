import type { DeviceRecord, PairingRecord } from "../types";
import { db, type ProjectOneDatabase } from "./database";

const bytesToBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

// `crypto.subtle` is only exposed by Safari in a secure context. GitHub Pages
// is HTTPS, but an iPhone testing against Vite over a local HTTP address is
// not, so keep room-id derivation deterministic without making local use fail.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rotateRight = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));

function sha256Fallback(input: Uint8Array) {
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000) >>> 0);
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let [a, b, c, d, e, f, g, h] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [aa, bb, cc, dd, ee, ff, gg, hh] = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(ee, 6) ^ rotateRight(ee, 11) ^ rotateRight(ee, 25);
      const choose = (ee & ff) ^ (~ee & gg);
      const temp1 = (hh + s1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(aa, 2) ^ rotateRight(aa, 13) ^ rotateRight(aa, 22);
      const majority = (aa & bb) ^ (aa & cc) ^ (bb & cc);
      const temp2 = (s0 + majority) >>> 0;
      [hh, gg, ff, ee, dd, cc, bb, aa] = [gg, ff, ee, (dd + temp1) >>> 0, cc, bb, aa, (temp1 + temp2) >>> 0];
    }
    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
    e = (e + ee) >>> 0;
    f = (f + ff) >>> 0;
    g = (g + gg) >>> 0;
    h = (h + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  const output = new DataView(digest.buffer);
  [a, b, c, d, e, f, g, h].forEach((value, index) => output.setUint32(index * 4, value));
  return digest;
}

export const randomId = () => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)));
};

export const randomSecret = () => bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export const validPairingSecret = (value: string | null): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(value);

export async function ensureIdentity(
  invitedSecret?: string,
  database: ProjectOneDatabase = db,
): Promise<{ device: DeviceRecord; pairing: PairingRecord; inviteIgnored: boolean }> {
  return database.transaction("rw", database.devices, database.pairing, async () => {
    const now = new Date().toISOString();
    let device = await database.devices.get("local");
    let pairing = await database.pairing.get("pairing");
    const inviteIgnored = Boolean(pairing && invitedSecret && pairing.secret !== invitedSecret);

    if (!device) {
      device = { id: "local", deviceId: randomId(), createdAt: now, label: "iPhone" };
      await database.devices.add(device);
    }
    if (!pairing) {
      pairing = { id: "pairing", secret: invitedSecret ?? randomSecret(), createdAt: now };
      await database.pairing.add(pairing);
    }
    return { device, pairing, inviteIgnored };
  });
}

export async function roomIdFromSecret(secret: string) {
  const bytes = new TextEncoder().encode(`project-one-room:${secret}`);
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle?.digest
    ? new Uint8Array(await subtle.digest("SHA-256", bytes))
    : sha256Fallback(bytes);
  return bytesToBase64Url(digest);
}
