import { useSyncExternalStore } from "react";
import type { RelayState } from "./client.ts";

type TransferProgress = RelayState["transfer"];

let snapshots: Readonly<Record<string, TransferProgress | undefined>> = {};
const listeners = new Set<() => void>();

/**
 * Relay callbacks can arrive once per acknowledgement. Keeping this tiny
 * external store separate from App state prevents every chunk from remapping
 * and rendering the document list.
 */
export function publishTransferProgress(key: string, transfer: TransferProgress | undefined): void {
  if (snapshots[key] === transfer) return;
  snapshots = { ...snapshots, [key]: transfer };
  for (const listener of listeners) listener();
}

export function subscribeTransferProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readTransferProgress(key: string): TransferProgress | undefined {
  return snapshots[key];
}

export function useTransferProgress(key: string): TransferProgress | undefined {
  return useSyncExternalStore(
    subscribeTransferProgress,
    () => readTransferProgress(key),
    () => undefined,
  );
}
