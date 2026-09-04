import { deriveTransferKey, encryptChunk } from "../../../../packages/crypto/src/index.ts";
import { DEFAULT_CHUNK_SIZE, parseTransferControlMessage, type TransferStartMessage } from "../../../../packages/protocol/src/index.ts";
import { getOrCreateIdentity, getStoredPairing, refreshMobileSession, type StoredMobilePairing } from "../pairing/client.ts";
import { ExpoFileChunkSource, sha256File } from "./expo-file-source.ts";
import { TransferSender, type SenderProgress } from "./sender.ts";

export type RelayState = { connected: boolean; desktopOnline: boolean; transfer?: SenderProgress & { transferId: string; filename: string } };

type ActiveTransfer = { meta: TransferStartMessage; source: ExpoFileChunkSource; sender: TransferSender; resolve: () => void; reject: (error: Error) => void };

export class MobileRelayClient {
  private socket: WebSocket | null = null;
  private pairing: StoredMobilePairing | null = null;
  private active: ActiveTransfer | null = null;
  private state: RelayState = { connected: false, desktopOnline: false };
  constructor(private readonly relayBaseUrl: string, private readonly onState: (state: RelayState) => void = () => undefined) {}

  snapshot(): RelayState { return this.state; }

  async connect(): Promise<void> {
    this.pairing = await getStoredPairing(); if (!this.pairing) throw new Error("pairing_invalid");
    const session = await refreshMobileSession(this.relayBaseUrl, this.pairing);
    const url = new URL(this.relayBaseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/connect"; url.search = new URLSearchParams({ token: session.token }).toString();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url.toString()); socket.binaryType = "arraybuffer";
      socket.onopen = () => { this.socket = socket; this.update({ connected: true }); resolve(); };
      socket.onerror = () => reject(new Error("relay_unavailable"));
      socket.onclose = () => { if (this.socket === socket) this.socket = null; this.update({ connected: false, desktopOnline: false }); };
      socket.onmessage = (event) => { if (typeof event.data === "string") this.handleControl(event.data).catch((error) => this.failActive(error)); };
    });
  }

  disconnect(): void { this.socket?.close(); this.socket = null; this.update({ connected: false, desktopOnline: false }); }

  async sendFile(input: { uri: string; name: string; mime: string }): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("relay_unavailable"); if (!this.pairing) throw new Error("pairing_invalid"); if (this.active) throw new Error("transfer_in_progress");
    const identity = await getOrCreateIdentity(); const source = new ExpoFileChunkSource(input.uri); const transferId = crypto.randomUUID(); const key = deriveTransferKey(identity.secretKey, this.pairing.desktopPublicKey, transferId);
    const meta: TransferStartMessage = { type: "transfer:start", transferId, destinationDeviceId: this.pairing.desktopId, name: input.name, size: source.size, mime: input.mime, sha256: sha256File(input.uri), chunkSize: DEFAULT_CHUNK_SIZE };
    await new Promise<void>((resolve, reject) => {
      const sender = new TransferSender(meta, source, (frame) => this.socket!.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength)), 8 * 1024 * 1024, (index, payload) => encryptChunk(key, transferId, index, payload));
      this.active = { meta, source, sender, resolve, reject }; this.update({ transfer: { ...sender.progress(), transferId, filename: input.name } }); this.socket!.send(JSON.stringify(meta));
    });
  }

  private async handleControl(raw: string): Promise<void> {
    let value: unknown; try { value = JSON.parse(raw); } catch { return; }
    if (value && typeof value === "object" && (value as { type?: string }).type === "presence:update") { const presence = value as { role?: string; deviceId?: string; online?: boolean }; if (presence.role === "desktop" && presence.deviceId === this.pairing?.desktopId) this.update({ desktopOnline: Boolean(presence.online) }); return; }
    if (value && typeof value === "object" && (value as { type?: string }).type === "relay:error") { throw new Error(String((value as { code?: string }).code ?? "relay_unavailable")); }
    const message = parseTransferControlMessage(value); const active = this.active; if (!active || message.transferId !== active.meta.transferId) return;
    if (message.type === "transfer:accept") { const progress = await active.sender.start(message.resumeFromChunk); this.updateTransfer(progress); return; }
    if (message.type === "transfer:ack") { const progress = await active.sender.acknowledge(message.receivedThroughChunk); this.updateTransfer(progress); return; }
    if (message.type === "transfer:resume") { const progress = await active.sender.resume(message.receivedThroughChunk); this.updateTransfer(progress); return; }
    if (message.type === "transfer:reject") { throw new Error(message.reason); }
    if (message.type === "transfer:complete") { active.source.close(); active.resolve(); this.active = null; this.update({ transfer: undefined }); }
  }

  private updateTransfer(progress: SenderProgress) { const active=this.active; if (active) this.update({ transfer: { ...progress, transferId: active.meta.transferId, filename: active.meta.name } }); }
  private failActive(error: unknown) { const active=this.active; if (!active) return; active.source.close(); active.reject(error instanceof Error?error:new Error("transfer_failed")); this.active=null; this.update({ transfer: undefined }); }
  private update(patch: Partial<RelayState>) { this.state={...this.state,...patch}; this.onState(this.state); }
}
