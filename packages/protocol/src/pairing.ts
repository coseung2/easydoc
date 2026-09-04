import { PROTOCOL_VERSION } from "./constants.ts";
export type PairingPayload = { version: typeof PROTOCOL_VERSION; desktopId: string; roomId: string; publicKey: string; pairingToken: string; expiresAt: number };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
export function isPairingPayload(value: unknown): value is PairingPayload {
  return isRecord(value) && value.version === PROTOCOL_VERSION && isString(value.desktopId, 256) && isString(value.roomId, 256) && isString(value.publicKey, 4096) && isString(value.pairingToken, 1024) && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) > 0;
}
export function parsePairingPayload(value: string | unknown): PairingPayload {
  let candidate: unknown = value;
  if (typeof value === "string") { try { candidate = JSON.parse(value); } catch { throw new Error("invalid_pairing_json"); } }
  if (!isPairingPayload(candidate)) throw new Error("invalid_pairing_payload");
  return candidate;
}
export function assertPairingPayloadFresh(payload: PairingPayload, now = Date.now()): void {
  if (payload.expiresAt <= now) throw new Error("pairing_expired");
}
