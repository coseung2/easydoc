import { parseTransferControlMessage } from "../../../packages/protocol/src/index.ts";
import type { DeviceRole, SessionCredential } from "./auth.ts";

export type RelayPayload = string | ArrayBuffer | Uint8Array;
export type RelaySocket = { send(data: RelayPayload): void; close(code?: number, reason?: string): void };
type Session = SessionCredential & { socket: RelaySocket };

export class RelayRoom {
  private sessions = new Map<DeviceRole, Session>();

  attach(credential: SessionCredential, socket: RelaySocket): void {
    const previous = this.sessions.get(credential.role);
    if (previous) previous.socket.close(4001, "replaced");
    this.sessions.set(credential.role, { ...credential, socket });
    this.broadcastPresence(credential.role, credential.deviceId, true);
    const peerRole: DeviceRole = credential.role === "mobile" ? "desktop" : "mobile";
    const peer = this.sessions.get(peerRole);
    if (peer) socket.send(JSON.stringify({ type: "presence:update", role: peer.role, deviceId: peer.deviceId, online: true }));
  }

  detach(role: DeviceRole, socket: RelaySocket): void {
    const current = this.sessions.get(role);
    if (!current || current.socket !== socket) return;
    this.sessions.delete(role);
    this.broadcastPresence(role, current.deviceId, false);
  }

  handle(role: DeviceRole, data: RelayPayload): void {
    const source = this.sessions.get(role);
    if (!source) throw new Error("unknown_session");
    const destinationRole: DeviceRole = role === "mobile" ? "desktop" : "mobile";
    const destination = this.sessions.get(destinationRole);

    if (typeof data !== "string") {
      if (!destination) throw new Error("destination_offline");
      destination.socket.send(data);
      return;
    }

    const message = parseTransferControlMessage(data);
    if (message.type === "transfer:start" && role === "mobile") {
      if (!destination || destination.deviceId !== message.destinationDeviceId) {
        source.socket.send(JSON.stringify({ type: "transfer:reject", transferId: message.transferId, reason: "destination_offline" }));
        return;
      }
    }
    if (!destination) throw new Error("destination_offline");
    destination.socket.send(data);
  }

  private broadcastPresence(role: DeviceRole, deviceId: string, online: boolean): void {
    const payload = JSON.stringify({ type: "presence:update", role, deviceId, online });
    for (const session of this.sessions.values()) session.socket.send(payload);
  }
}
