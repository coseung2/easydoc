import { assertPairingPayloadFresh, parsePairingPayload, PROTOCOL_VERSION, type PairingPayload } from "../../../packages/protocol/src/index.ts";
import { signSessionCredential } from "./auth.ts";

export type PairingRelationship = {
  roomId: string;
  desktopId: string;
  desktopPublicKey: string;
  mobileId: string;
  mobilePublicKey: string;
  pairedAt: number;
};

export type PairingSessionTokens = {
  desktopToken: string;
  mobileToken: string;
  expiresAt: number;
};

type PendingPairing = { payload: PairingPayload };
type PairingRegistryOptions = {
  now?: () => number;
  token?: () => string;
  roomId?: () => string;
};

const PAIRING_TTL_MS = 5 * 60 * 1000;

function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export class PairingRegistry {
  private readonly now: () => number;
  private readonly createToken: () => string;
  private readonly createRoomId: () => string;
  private readonly pending = new Map<string, PendingPairing>();
  private readonly relationships = new Map<string, PairingRelationship>();

  constructor(options: PairingRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createToken = options.token ?? (() => randomBase64Url());
    this.createRoomId = options.roomId ?? (() => `room_${crypto.randomUUID()}`);
  }

  issue(desktopId: string, desktopPublicKey: string): PairingPayload {
    if (!desktopId || !desktopPublicKey) throw new Error("pairing_invalid");
    const issuedAt = this.now();
    const payload: PairingPayload = {
      version: PROTOCOL_VERSION,
      desktopId,
      roomId: this.createRoomId(),
      publicKey: desktopPublicKey,
      pairingToken: this.createToken(),
      expiresAt: issuedAt + PAIRING_TTL_MS,
    };
    this.pending.set(payload.pairingToken, { payload });
    return payload;
  }

  claim(rawPayload: PairingPayload | string, mobileId: string, mobilePublicKey: string): PairingRelationship {
    if (!mobileId || !mobilePublicKey) throw new Error("pairing_invalid");
    const payload = parsePairingPayload(rawPayload);
    assertPairingPayloadFresh(payload, this.now());
    const pending = this.pending.get(payload.pairingToken);
    if (!pending || !this.samePayload(pending.payload, payload)) throw new Error("pairing_invalid");

    this.pending.delete(payload.pairingToken);
    const relationship: PairingRelationship = {
      roomId: payload.roomId,
      desktopId: payload.desktopId,
      desktopPublicKey: payload.publicKey,
      mobileId,
      mobilePublicKey,
      pairedAt: this.now(),
    };
    this.relationships.set(payload.roomId, relationship);
    return relationship;
  }

  getRelationship(roomId: string): PairingRelationship | undefined {
    return this.relationships.get(roomId);
  }

  revoke(roomId: string): boolean {
    return this.relationships.delete(roomId);
  }

  isAuthorized(roomId: string, role: "mobile" | "desktop", deviceId: string): boolean {
    const relationship = this.relationships.get(roomId);
    if (!relationship) return false;
    return role === "mobile" ? relationship.mobileId === deviceId : relationship.desktopId === deviceId;
  }

  async issueSessionTokens(relationship: PairingRelationship, signingSecret: string, expiresAt: number): Promise<PairingSessionTokens> {
    if (expiresAt <= this.now()) throw new Error("pairing_invalid");
    const desktopToken = await signSessionCredential({ version: 1, roomId: relationship.roomId, deviceId: relationship.desktopId, role: "desktop", expiresAt }, signingSecret);
    const mobileToken = await signSessionCredential({ version: 1, roomId: relationship.roomId, deviceId: relationship.mobileId, role: "mobile", expiresAt }, signingSecret);
    return { desktopToken, mobileToken, expiresAt };
  }

  private samePayload(left: PairingPayload, right: PairingPayload): boolean {
    return left.version === right.version && left.desktopId === right.desktopId && left.roomId === right.roomId && left.publicKey === right.publicKey && left.pairingToken === right.pairingToken && left.expiresAt === right.expiresAt;
  }
}

export { PAIRING_TTL_MS };
