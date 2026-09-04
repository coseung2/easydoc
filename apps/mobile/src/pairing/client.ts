import * as SecureStore from "expo-secure-store";
import { generateDeviceKeyPair, type DeviceKeyPair } from "../../../../packages/crypto/src/index.ts";
import { parsePairingPayload, type PairingPayload } from "../../../../packages/protocol/src/index.ts";

const IDENTITY_KEY = "easydoc.device.identity.v1";
const PAIRING_KEY = "easydoc.pairing.v1";
const RELAY_URL_KEY = "easydoc.relay.url.v1";

export type MobileIdentity = DeviceKeyPair & { deviceId: string };
export type StoredMobilePairing = {
  roomId: string;
  desktopId: string;
  desktopPublicKey: string;
  mobileSecret: string;
};
export type SessionInfo = { token: string; expiresAt: number; peerPublicKey: string };

async function postJson<T>(url: string, value: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `relay_http_${response.status}`);
  return body;
}


export async function getStoredRelayBaseUrl(fallback = ""): Promise<string> {
  return (await SecureStore.getItemAsync(RELAY_URL_KEY)) ?? fallback;
}

export async function setStoredRelayBaseUrl(value: string): Promise<string> {
  const trimmed = value.trim().replace(/\/$/u, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("invalid_relay_url");
  await SecureStore.setItemAsync(RELAY_URL_KEY, trimmed);
  return trimmed;
}

export async function getOrCreateIdentity(): Promise<MobileIdentity> {
  const stored = await SecureStore.getItemAsync(IDENTITY_KEY);
  if (stored) return JSON.parse(stored) as MobileIdentity;
  const keys = generateDeviceKeyPair();
  const identity: MobileIdentity = { deviceId: `mobile_${crypto.randomUUID()}`, ...keys };
  await SecureStore.setItemAsync(IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

export async function getStoredPairing(): Promise<StoredMobilePairing | null> {
  const stored = await SecureStore.getItemAsync(PAIRING_KEY);
  return stored ? JSON.parse(stored) as StoredMobilePairing : null;
}

export async function claimPairing(relayBaseUrl: string, qrPayload: string): Promise<StoredMobilePairing> {
  const pairing: PairingPayload = parsePairingPayload(qrPayload);
  const identity = await getOrCreateIdentity();
  const result = await postJson<{ roomId: string; desktopId: string; desktopPublicKey: string; mobileSecret: string }>(`${relayBaseUrl.replace(/\/$/u, "")}/pairing/claim`, {
    pairing,
    mobileId: identity.deviceId,
    mobilePublicKey: identity.publicKey,
  });
  const stored: StoredMobilePairing = { roomId: result.roomId, desktopId: result.desktopId, desktopPublicKey: result.desktopPublicKey, mobileSecret: result.mobileSecret };
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(stored));
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

export async function revokePairing(relayBaseUrl: string, sessionToken: string): Promise<void> {
  await postJson(`${relayBaseUrl.replace(/\/$/u, "")}/pairing/revoke`, {}, { authorization: `Bearer ${sessionToken}` });
  await SecureStore.deleteItemAsync(PAIRING_KEY);
}
