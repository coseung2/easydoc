import type { PairingRef } from "../../../../packages/protocol/src/index.ts";

export function applyDesktopAlias<T extends PairingRef & { desktopAlias?: string }>(pairings: T[], ref: PairingRef, desktopAlias: string): T[] {
  return pairings.map((pairing) => pairing.roomId === ref.roomId && pairing.desktopId === ref.desktopId
    ? { ...pairing, desktopAlias } : pairing);
}
