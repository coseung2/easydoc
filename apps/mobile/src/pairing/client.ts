import * as SecureStore from "expo-secure-store";
import { generateDeviceKeyPair, type DeviceKeyPair } from "../../../../packages/crypto/src/index.ts";
import { pairingRefKey, parsePairingPayload, type PairingPayload, type PairingRef } from "../../../../packages/protocol/src/index.ts";

const IDENTITY_KEY = "easydoc.device.identity.v1";
const PAIRING_KEY = "easydoc.pairing.v1";
const SELECTED_PAIRING_KEY = "easydoc.pairing.selected.v1";
export const APP_RELAY_BASE_URL = "https://easydoc-relay.mdownloader.workers.dev";

export type MobileIdentity = DeviceKeyPair & { deviceId: string };
export type StoredMobilePairing = {
  roomId: string;
  desktopId: string;
  desktopPublicKey: string;
  desktopAlias?: string;
  mobileSecret: string;
};
export type StoredMobilePairings = StoredMobilePairing[];
export type SessionInfo = { token: string; expiresAt: number; peerPublicKey: string };
export type { PairingRef };

export function getPairingKey(pairing: PairingRef): string {
  return pairingRefKey(pairing);
}

function matchesPairing(pairing: StoredMobilePairing, ref: PairingRef | string): boolean {
  return typeof ref === "string" ? pairing.desktopId === ref || getPairingKey(pairing) === ref : pairing.roomId === ref.roomId && pairing.desktopId === ref.desktopId;
}

async function postJson<T>(url: string, value: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `relay_http_${response.status}`);
  return body;
}

export async function getOrCreateIdentity(): Promise<MobileIdentity> {
  const stored = await SecureStore.getItemAsync(IDENTITY_KEY);
  if (stored) return JSON.parse(stored) as MobileIdentity;
  const keys = generateDeviceKeyPair();
  const identity: MobileIdentity = { deviceId: `mobile_${crypto.randomUUID()}`, ...keys };
  await SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

export async function getStoredPairings(): Promise<StoredMobilePairings> {
  const stored = await SecureStore.getItemAsync(PAIRING_KEY);
  if (!stored) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(stored); }
  catch { throw new Error("저장된 PC 연결 정보를 읽을 수 없습니다. 앱을 다시 시작해 주세요."); }
  const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (!entries.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as Record<string, unknown>;
    return ["roomId", "desktopId", "desktopPublicKey", "mobileSecret"].every((key) => typeof value[key] === "string" && value[key].length > 0)
      && (value.desktopAlias === undefined || typeof value.desktopAlias === "string");
  })) throw new Error("저장된 PC 연결 정보가 올바르지 않습니다. 기존 정보는 보존했습니다.");
  const migrated = entries as StoredMobilePairings;
  if (Array.isArray(parsed)) return migrated;
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(migrated));
  return migrated;
}

export async function getStoredPairing(): Promise<StoredMobilePairing | null> {
  const pairings = await getStoredPairings();
  const selected = await SecureStore.getItemAsync(SELECTED_PAIRING_KEY);
  const pairing = pairings.find((item) => getPairingKey(item) === selected) ?? pairings.find((item) => item.desktopId === selected) ?? pairings[0] ?? null;
  if (pairing && selected !== getPairingKey(pairing)) await SecureStore.setItemAsync(SELECTED_PAIRING_KEY, getPairingKey(pairing));
  return pairing;
}

export async function selectPairing(ref: PairingRef | string): Promise<StoredMobilePairing | null> {
  const pairing = (await getStoredPairings()).find((item) => matchesPairing(item, ref)) ?? null;
  if (pairing) await SecureStore.setItemAsync(SELECTED_PAIRING_KEY, getPairingKey(pairing));
  return pairing;
}

export async function removePairing(ref: PairingRef | string): Promise<StoredMobilePairings> {
  const storedPairings = await getStoredPairings();
  const pairings = storedPairings.filter((pairing) => !matchesPairing(pairing, ref));
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairings));
  const selected = await SecureStore.getItemAsync(SELECTED_PAIRING_KEY);
  const selectedPairing = storedPairings.find((pairing) => getPairingKey(pairing) === selected || pairing.desktopId === selected);
  const removedSelected = selectedPairing ? !pairings.some((pairing) => getPairingKey(pairing) === getPairingKey(selectedPairing)) : selected === ref;
  if (removedSelected) {
    if (pairings[0]) await SecureStore.setItemAsync(SELECTED_PAIRING_KEY, getPairingKey(pairings[0]));
    else await SecureStore.deleteItemAsync(SELECTED_PAIRING_KEY);
  }
  return pairings;
}

export async function claimPairing(relayBaseUrl: string, qrPayload: string): Promise<StoredMobilePairing> {
  const pairing: PairingPayload = parsePairingPayload(qrPayload);
  const identity = await getOrCreateIdentity();
  const result = await postJson<{ roomId: string; desktopId: string; desktopPublicKey: string; mobileSecret: string }>(`${relayBaseUrl.replace(/\/$/u, "")}/pairing/claim`, {
    pairing,
    mobileId: identity.deviceId,
    mobilePublicKey: identity.publicKey,
  });
  const stored: StoredMobilePairing = { roomId: result.roomId, desktopId: result.desktopId, desktopPublicKey: result.desktopPublicKey, desktopAlias: pairing.desktopAlias, mobileSecret: result.mobileSecret };
  const pairings = (await getStoredPairings()).filter((item) => !matchesPairing(item, stored));
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify([stored, ...pairings]));
  await SecureStore.setItemAsync(SELECTED_PAIRING_KEY, getPairingKey(stored));
  return stored;
}

export async function refreshMobileSession(relayBaseUrl: string, pairing: StoredMobilePairing, identity?: MobileIdentity): Promise<SessionInfo> {
  const currentIdentity = identity ?? await getOrCreateIdentity();
  return postJson<SessionInfo>(`${relayBaseUrl.replace(/\/$/u, "")}/pairing/session`, {
    roomId: pairing.roomId,
    role: "mobile",
    deviceId: currentIdentity.deviceId,
    bootstrapSecret: pairing.mobileSecret,
  });
}

export async function revokePairing(relayBaseUrl: string, sessionToken: string): Promise<boolean> {
  const result = await postJson<{ revoked: boolean }>(`${relayBaseUrl.replace(/\/$/u, "")}/pairing/revoke`, {}, { authorization: `Bearer ${sessionToken}` });
  return result.revoked;
}

export async function revokeStoredPairing(relayBaseUrl: string, pairing: StoredMobilePairing): Promise<"revoked" | "already_revoked"> {
  let session: SessionInfo;
  try {
    session = await refreshMobileSession(relayBaseUrl, pairing);
  } catch (error) {
    if (error instanceof Error && error.message === "pairing_invalid") return "already_revoked";
    throw error;
  }
  return await revokePairing(relayBaseUrl, session.token) ? "revoked" : "already_revoked";
}
