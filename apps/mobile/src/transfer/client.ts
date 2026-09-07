import { deriveTransferKey, encryptChunk } from "../../../../packages/crypto/src/index.ts";
import { DEFAULT_CHUNK_SIZE, parseDesktopProfileMessage, parseTransferControlMessage, type TransferStartMessage } from "../../../../packages/protocol/src/index.ts";
import { getOrCreateIdentity, refreshMobileSession, updateStoredDesktopAlias, type StoredMobilePairing } from "../pairing/client.ts";
import { ExpoFileChunkSource, sha256File } from "./expo-file-source.ts";
import { TransferSender, type SenderProgress } from "./sender.ts";
import { ResponseTimeoutController } from "./timeout-controller.ts";

export type TransferPhase = "preparing" | "transferring" | "retrying";
export type RelayState = { connected: boolean; desktopOnline: boolean; desktopAlias?: string; transfer?: SenderProgress & { transferId: string; filename: string; status: TransferPhase; retryCount: number } };

type ActiveTransfer = {
  meta: TransferStartMessage;
  source: ExpoFileChunkSource;
  sender: TransferSender;
  resolve: () => void;
  reject: (error: Error) => void;
  phase: "awaiting_accept" | "awaiting_ack" | "awaiting_complete";
  retryCount: number;
  bestResumeFromChunk: number;
  responseTimer: ResponseTimeoutController | null;
};
type ConnectAttempt = { generation: number; socket: WebSocket | null; cancel: () => void };

export type MobileRelayClientOptions = {
  connectTimeoutMs?: number;
  transferResponseTimeoutMs?: number;
  maxTransferRetries?: number;
};

const CONNECT_TIMEOUT_MS = 15_000;
const TRANSFER_RESPONSE_TIMEOUT_MS = 12_000;
const MAX_TRANSFER_RETRIES = 2;

export class MobileRelayClient {
  private controlMessages: Promise<void> = Promise.resolve();
  private socket: WebSocket | null = null;
  private connectAttempt: ConnectAttempt | null = null;
  private connectionGeneration = 0;
  private active: ActiveTransfer | null = null;
  private preparingTransferId: string | null = null;
  private cancelledPreparations = new Set<string>();
  private state: RelayState;
  private readonly connectTimeoutMs: number;
  private readonly transferResponseTimeoutMs: number;
  private readonly maxTransferRetries: number;
  constructor(
    private readonly relayBaseUrl: string,
    private readonly pairing: StoredMobilePairing,
    private readonly onState: (state: RelayState) => void = () => undefined,
    options: MobileRelayClientOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.transferResponseTimeoutMs = options.transferResponseTimeoutMs ?? TRANSFER_RESPONSE_TIMEOUT_MS;
    this.maxTransferRetries = options.maxTransferRetries ?? MAX_TRANSFER_RETRIES;
    this.state = { connected: false, desktopOnline: false, desktopAlias: pairing.desktopAlias };
  }

  snapshot(): RelayState { return this.state; }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.connectAttempt?.cancel();
    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const attempt: ConnectAttempt = { generation, socket: null, cancel: () => finish(new Error("connection_cancelled")) };
      const timeout = setTimeout(() => finish(new Error("relay_unavailable")), this.connectTimeoutMs);
      const isCurrent = () => this.connectionGeneration === generation && this.connectAttempt === attempt;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.connectAttempt === attempt) this.connectAttempt = null;
        if (error) {
          const socket = attempt.socket;
          attempt.socket = null;
          if (socket && socket !== this.socket) socket.close();
          reject(error);
        } else resolve();
      };
      attempt.cancel = () => finish(new Error("connection_cancelled"));
      this.connectAttempt = attempt;
      void (async () => {
        try {
          const session = await refreshMobileSession(this.relayBaseUrl, this.pairing);
          if (!isCurrent()) return;
          const url = new URL(this.relayBaseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/connect"; url.search = new URLSearchParams({ token: session.token }).toString();
          const socket = new WebSocket(url.toString());
          attempt.socket = socket;
          socket.binaryType = "arraybuffer";
          socket.onopen = () => {
            if (!isCurrent()) { socket.close(); return; }
            attempt.socket = null;
            this.socket = socket;
            this.update({ connected: true });
            finish();
          };
          socket.onerror = () => { if (isCurrent()) finish(new Error("relay_unavailable")); };
          socket.onclose = () => {
            if (!settled && isCurrent()) { finish(new Error("relay_unavailable")); return; }
            if (this.connectionGeneration !== generation || this.socket !== socket) return;
            this.socket = null;
            this.failActive(new Error("relay_unavailable"));
            this.update({ connected: false, desktopOnline: false });
          };
          socket.onmessage = (event) => {
            if (this.connectionGeneration !== generation || this.socket !== socket || typeof event.data !== "string") return;
            const raw = event.data;
            this.controlMessages = this.controlMessages.then(async () => {
              if (this.connectionGeneration !== generation || this.socket !== socket) return;
              const active = this.active;
              try { await this.handleControl(raw); }
              catch (error) { if (this.active === active) this.failActive(error); }
            });
          };
        } catch (error) {
          if (isCurrent()) finish(error instanceof Error ? error : new Error("relay_unavailable"));
        }
      })();
    });
  }

  disconnect(): void {
    this.connectionGeneration += 1;
    this.connectAttempt?.cancel();
    this.connectAttempt = null;
    const socket = this.socket;
    this.socket = null;
    if (this.preparingTransferId) this.cancelledPreparations.add(this.preparingTransferId);
    this.failActive(new Error("connection_cancelled"));
    socket?.close();
    this.update({ connected: false, desktopOnline: false });
  }

  /** Cancel preparation or the active transfer. The queue owns the durable
   * cancelled state; this method only stops network/file work. */
  cancelActiveTransfer(transferId?: string): boolean {
    const preparing = this.preparingTransferId;
    if (preparing) {
      if (transferId && transferId !== preparing) {
        this.cancelledPreparations.add(transferId);
        return true;
      }
      this.cancelledPreparations.add(preparing);
      this.update({ transfer: undefined });
      return true;
    }
    const active = this.active;
    if (!active) {
      // Covers the small race where the queue row was selected for sending,
      // but sendFile has not assigned its preparation slot yet.
      if (transferId) this.cancelledPreparations.add(transferId);
      return Boolean(transferId);
    }
    if (transferId && transferId !== active.meta.transferId) {
      this.cancelledPreparations.add(transferId);
      return true;
    }
    try { this.socket?.send(JSON.stringify({ type: "transfer:cancel", transferId: active.meta.transferId })); }
    catch { /* The close/failure path below still settles the caller. */ }
    this.failActive(new Error("transfer_cancelled"));
    return true;
  }

  async sendFile(input: { uri: string; name: string; mime: string; transferId?: string }): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("relay_unavailable");
    if (!this.pairing) throw new Error("pairing_invalid");
    if (this.active || this.preparingTransferId) throw new Error("transfer_in_progress");
    const transferId = input.transferId ?? crypto.randomUUID();
    const source = new ExpoFileChunkSource(input.uri);
    if (this.cancelledPreparations.has(transferId)) {
      source.close();
      this.cancelledPreparations.delete(transferId);
      throw new Error("transfer_cancelled");
    }
    this.preparingTransferId = transferId;
    this.cancelledPreparations.delete(transferId);
    this.update({ transfer: { sentBytes: 0, acknowledgedBytes: 0, inFlightBytes: 0, nextChunk: 0, complete: false, transferId, filename: input.name, status: "preparing", retryCount: 0 } });
    try {
      const identity = await getOrCreateIdentity();
      const digest = await sha256File(input.uri, 1024 * 1024, { shouldCancel: () => this.cancelledPreparations.has(transferId) });
      if (this.cancelledPreparations.has(transferId)) throw new Error("transfer_cancelled");
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("relay_unavailable");
      const key = deriveTransferKey(identity.secretKey, this.pairing.desktopPublicKey, transferId);
      const meta: TransferStartMessage = { type: "transfer:start", transferId, destinationDeviceId: this.pairing.desktopId, name: input.name, size: source.size, mime: input.mime, sha256: digest, chunkSize: DEFAULT_CHUNK_SIZE };
      await new Promise<void>((resolve, reject) => {
        const sender = new TransferSender(meta, source, (frame) => {
          if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("relay_unavailable");
          this.socket.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
        }, 8 * 1024 * 1024, (index, payload) => encryptChunk(key, transferId, index, payload));
        const active: ActiveTransfer = { meta, source, sender, resolve, reject, phase: "awaiting_accept", retryCount: 0, bestResumeFromChunk: -1, responseTimer: null };
        this.active = active;
        this.preparingTransferId = null;
        try {
          this.socket!.send(JSON.stringify(meta));
          this.armResponseTimeout(active);
        } catch (error) {
          this.failActive(error);
        }
      });
    } catch (error) {
      // The active path closes the source. Preparation failures have not been
      // assigned to active yet, so close it here and remove the banner.
      const currentActive = this.active as ActiveTransfer | null;
      if (!currentActive || currentActive.meta.transferId !== transferId) {
        source.close();
        this.update({ transfer: undefined });
      }
      throw error;
    } finally {
      if (this.preparingTransferId === transferId) this.preparingTransferId = null;
      this.cancelledPreparations.delete(transferId);
    }
  }

  private async handleControl(raw: string): Promise<void> {
    let value: unknown; try { value = JSON.parse(raw); } catch { return; }
    if (value && typeof value === "object" && (value as { type?: string }).type === "presence:update") { const presence = value as { role?: string; deviceId?: string; online?: boolean }; if (presence.role === "desktop" && presence.deviceId === this.pairing?.desktopId) this.update({ desktopOnline: Boolean(presence.online) }); return; }
    if (value && typeof value === "object" && (value as { type?: string }).type === "relay:error") { throw new Error(String((value as { code?: string }).code ?? "relay_unavailable")); }
    const profile = parseDesktopProfileMessage(value);
    if (profile) {
      if (profile.desktopId === this.pairing.desktopId) {
        // Profile persistence is advisory metadata. A storage hiccup must not
        // reject or tear down an unrelated file transfer on this socket.
        try {
          const updated = await updateStoredDesktopAlias(this.pairing, profile.desktopAlias);
          if (updated) {
            this.pairing.desktopAlias = profile.desktopAlias;
            this.update({ desktopAlias: profile.desktopAlias });
          }
        } catch { /* Keep the current alias until the next reconnect. */ }
      }
      return;
    }
    const message = parseTransferControlMessage(value); const active = this.active; if (!active || message.transferId !== active.meta.transferId) return;
    if (message.type === "transfer:accept") {
      if (active.phase !== "awaiting_accept") return;
      active.phase = "awaiting_ack";
      if (message.resumeFromChunk > active.bestResumeFromChunk) {
        active.bestResumeFromChunk = message.resumeFromChunk;
        active.retryCount = 0;
      }
      const progress = await active.sender.start(message.resumeFromChunk);
      if (this.active !== active) return;
      this.updateTransfer(progress, "transferring");
      this.armResponseTimeout(active);
      return;
    }
    if (message.type === "transfer:ack") {
      const before = active.sender.progress();
      const progress = await active.sender.acknowledge(message.receivedThroughChunk);
      if (this.active !== active) return;
      const advanced = progress.acknowledgedBytes > before.acknowledgedBytes;
      if (advanced) {
        active.phase = progress.complete ? "awaiting_complete" : "awaiting_ack";
        active.bestResumeFromChunk = Math.max(active.bestResumeFromChunk, message.receivedThroughChunk + 1);
        active.retryCount = 0;
      }
      this.updateTransfer(progress, "transferring");
      if (advanced) this.armResponseTimeout(active);
      return;
    }
    if (message.type === "transfer:resume") {
      const before = active.sender.progress();
      const progress = await active.sender.resume(message.receivedThroughChunk);
      if (this.active !== active) return;
      const advanced = progress.acknowledgedBytes > before.acknowledgedBytes;
      if (advanced) {
        active.phase = progress.complete ? "awaiting_complete" : "awaiting_ack";
        active.bestResumeFromChunk = Math.max(active.bestResumeFromChunk, message.receivedThroughChunk + 1);
        active.retryCount = 0;
      }
      this.updateTransfer(progress, "transferring");
      if (advanced) this.armResponseTimeout(active);
      return;
    }
    if (message.type === "transfer:reject") { throw new Error(message.reason); }
    if (message.type === "transfer:complete") {
      if (message.bytes !== active.meta.size || message.sha256 !== active.meta.sha256) throw new Error("checksum_mismatch");
      this.clearResponseTimeout(active);
      active.source.close(); active.resolve(); this.active = null; this.update({ transfer: undefined });
    }
  }

  private armResponseTimeout(active: ActiveTransfer): void {
    if (this.active !== active) return;
    this.clearResponseTimeout(active);
    active.responseTimer = new ResponseTimeoutController(this.transferResponseTimeoutMs, () => { void this.retryOrFail(active); });
    active.responseTimer.arm();
  }

  private clearResponseTimeout(active: ActiveTransfer): void {
    active.responseTimer?.clear();
    active.responseTimer = null;
  }

  private async retryOrFail(active: ActiveTransfer): Promise<void> {
    if (this.active !== active) return;
    if (active.retryCount >= this.maxTransferRetries) {
      this.failActive(new Error(active.phase === "awaiting_accept" ? "transfer_accept_timeout" : "transfer_ack_timeout"));
      return;
    }
    active.retryCount += 1;
    active.phase = "awaiting_accept";
    this.updateTransfer(active.sender.progress(), "retrying");
    try {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("relay_unavailable");
      // Re-sending metadata lets the receiver resume from its durable chunk
      // position. The following accept resets sender in-flight state safely.
      this.socket.send(JSON.stringify(active.meta));
      this.armResponseTimeout(active);
    } catch (error) { this.failActive(error); }
  }

  private updateTransfer(progress: SenderProgress, status: TransferPhase = "transferring") {
    const active = this.active;
    if (active) this.update({ transfer: { ...progress, transferId: active.meta.transferId, filename: active.meta.name, status, retryCount: active.retryCount } });
  }
  private failActive(error: unknown) {
    const active = this.active;
    if (!active) return;
    this.clearResponseTimeout(active);
    active.source.close();
    active.reject(error instanceof Error ? error : new Error("transfer_failed"));
    this.active = null;
    this.update({ transfer: undefined });
  }
  private update(patch: Partial<RelayState>) { this.state={...this.state,...patch}; this.onState(this.state); }
}
