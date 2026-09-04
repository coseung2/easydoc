export type DeviceRole = "mobile" | "desktop";
export type SessionCredential = { version: 1; roomId: string; deviceId: string; role: DeviceRole; expiresAt: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const base64UrlEncode = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const base64UrlDecode = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "base64url"));

async function hmac(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function signSessionCredential(credential: SessionCredential, secret: string): Promise<string> {
  if (!secret) throw new Error("missing_session_secret");
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(credential)));
  return `${payload}.${base64UrlEncode(await hmac(secret, payload))}`;
}

export async function verifySessionCredential(token: string, secret: string, now = Date.now()): Promise<SessionCredential> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("pairing_invalid");
  const expected = await hmac(secret, payload);
  const actual = base64UrlDecode(signature);
  if (expected.byteLength !== actual.byteLength) throw new Error("pairing_invalid");
  let diff = 0;
  for (let index = 0; index < expected.byteLength; index += 1) diff |= expected[index] ^ actual[index];
  if (diff !== 0) throw new Error("pairing_invalid");
  let value: unknown;
  try { value = JSON.parse(decoder.decode(base64UrlDecode(payload))); } catch { throw new Error("pairing_invalid"); }
  if (!isSessionCredential(value)) throw new Error("pairing_invalid");
  if (value.expiresAt <= now) throw new Error("pairing_invalid");
  return value;
}

function isSessionCredential(value: unknown): value is SessionCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.roomId === "string" && record.roomId.length > 0 && typeof record.deviceId === "string" && record.deviceId.length > 0 && (record.role === "mobile" || record.role === "desktop") && Number.isSafeInteger(record.expiresAt) && Number(record.expiresAt) > 0;
}
