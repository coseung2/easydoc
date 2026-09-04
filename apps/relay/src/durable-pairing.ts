import {
  assertPairingPayloadFresh,
  parsePairingPayload,
  PROTOCOL_VERSION,
  type PairingPayload,
} from "../../../packages/protocol/src/index.ts";
import { signSessionCredential, type DeviceRole } from "./auth.ts";

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 5 * 60 * 1000;

export type DurableStorageLike = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
};

type PendingPairing = {
  payload: PairingPayload;
  desktopSecretHash: string;
};

export type StoredPairing = {
  roomId: string;
  desktopId: string;
  desktopPublicKey: string;
  desktopSecretHash: string;
  mobileId: string;
  mobilePublicKey: string;
  mobileSecretHash: string;
  pairedAt: number;
};

type Options = {
  now?: () => number;
  randomSecret?: () => string;
  randomRoomId?: () => string;
};

const encoder = new TextEncoder();

function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function samePayload(left: PairingPayload, right: PairingPayload): boolean {
  return left.version === right.version && left.desktopId === right.desktopId && left.roomId === right.roomId && left.publicKey === right.publicKey && left.pairingToken === right.pairingToken && left.expiresAt === right.expiresAt;
}

function pendingKey(token: string): string { return `pending:${token}`; }
function relationshipKey(roomId: string): string { return `relationship:${roomId}`; }

export class DurablePairingStore {
  private readonly storage: DurableStorageLike;
  private readonly now: () => number;
  private readonly createSecret: () => string;
  private readonly createRoomId: () => string;

  constructor(storage: DurableStorageLike, options: Options = {}) {
    this.storage = storage;
    this.now = options.now ?? (() => Date.now());
    this.createSecret = options.randomSecret ?? (() => randomBase64Url());
    this.createRoomId = options.randomRoomId ?? (() => `room_${crypto.randomUUID()}`);
  }

  async issue(desktopId: string, desktopPublicKey: string): Promise<{ pairing: PairingPayload; desktopSecret: string }> {
    if (!desktopId || !desktopPublicKey) throw new Error("pairing_invalid");
    const desktopSecret = this.createSecret();
    const pairingToken = this.createSecret();
    const pairing: PairingPayload = {
      version: PROTOCOL_VERSION,
      desktopId,
      roomId: this.createRoomId(),
      publicKey: desktopPublicKey,
      pairingToken,
      expiresAt: this.now() + PAIRING_TTL_MS,
    };
    await this.storage.put<PendingPairing>(pendingKey(pairingToken), { payload: pairing, desktopSecretHash: await sha256(desktopSecret) });
    return { pairing, desktopSecret };
  }

  async claim(rawPairing: PairingPayload | string, mobileId: string, mobilePublicKey: string): Promise<{ relationship: StoredPairing; mobileSecret: string }> {
    if (!mobileId || !mobilePublicKey) throw new Error("pairing_invalid");
    const pairing = parsePairingPayload(rawPairing);
    assertPairingPayloadFresh(pairing, this.now());
    const pending = await this.storage.get<PendingPairing>(pendingKey(pairing.pairingToken));
    if (!pending || !samePayload(pending.payload, pairing)) throw new Error("pairing_invalid");
    const mobileSecret = this.createSecret();
    const relationship: StoredPairing = {
      roomId: pairing.roomId,
      desktopId: pairing.desktopId,
      desktopPublicKey: pairing.publicKey,
      desktopSecretHash: pending.desktopSecretHash,
      mobileId,
      mobilePublicKey,
      mobileSecretHash: await sha256(mobileSecret),
      pairedAt: this.now(),
    };
    await this.storage.put(relationshipKey(pairing.roomId), relationship);
    await this.storage.delete(pendingKey(pairing.pairingToken));
    return { relationship, mobileSecret };
  }

  async issueSessionToken(roomId: string, role: DeviceRole, deviceId: string, bootstrapSecret: string, signingSecret: string): Promise<{ token: string; expiresAt: number }> {
    const relationship = await this.requireRelationship(roomId);
    const expectedDeviceId = role === "desktop" ? relationship.desktopId : relationship.mobileId;
    const expectedSecretHash = role === "desktop" ? relationship.desktopSecretHash : relationship.mobileSecretHash;
    if (deviceId !== expectedDeviceId || (await sha256(bootstrapSecret)) !== expectedSecretHash) throw new Error("pairing_invalid");
    const expiresAt = this.now() + SESSION_TTL_MS;
    const token = await signSessionCredential({ version: 1, roomId, deviceId, role, expiresAt }, signingSecret);
    return { token, expiresAt };
  }

  async revoke(roomId: string, role: DeviceRole, deviceId: string): Promise<boolean> {
    const relationship = await this.storage.get<StoredPairing>(relationshipKey(roomId));
    if (!relationship) return false;
    const expectedDeviceId = role === "desktop" ? relationship.desktopId : relationship.mobileId;
    if (deviceId !== expectedDeviceId) throw new Error("pairing_invalid");
    return this.storage.delete(relationshipKey(roomId));
  }

  async getRelationship(roomId: string): Promise<StoredPairing | undefined> {
    return this.storage.get<StoredPairing>(relationshipKey(roomId));
  }

  private async requireRelationship(roomId: string): Promise<StoredPairing> {
    const relationship = await this.getRelationship(roomId);
    if (!relationship) throw new Error("pairing_invalid");
    return relationship;
  }
}
