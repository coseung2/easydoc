import * as SQLite from "expo-sqlite";
import type { PairingRef } from "../../../../packages/protocol/src/index.ts";

export type QueuedTransfer = {
  id: string;
  uri: string;
  name: string;
  mime: string;
  status: "waiting" | "preparing" | "transferring" | "retrying" | "failed" | "completed" | "cancelled";
  createdAt: number;
  lastError?: string;
  target: PairingRef | null;
  /** True when this enqueue coalesced with an existing active row. */
  deduplicated?: boolean;
};

let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;

async function initializeDatabase() {
  const db = await SQLite.openDatabaseAsync("easydoc.db");
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS transfer_queue (
      id TEXT PRIMARY KEY NOT NULL,
      uri TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_error TEXT,
      target_room_id TEXT,
      target_desktop_id TEXT
    );
  `);
  const columns = await db.getAllAsync<{ name: string }>("PRAGMA table_info(transfer_queue)");
  if (!columns.some((column) => column.name === "target_room_id")) await db.execAsync("ALTER TABLE transfer_queue ADD COLUMN target_room_id TEXT");
  if (!columns.some((column) => column.name === "target_desktop_id")) await db.execAsync("ALTER TABLE transfer_queue ADD COLUMN target_desktop_id TEXT");
  // A process may be killed while preparing/sending. These states are safe to
  // retry after reopening the app, so do not strand them as active work.
  await db.runAsync("UPDATE transfer_queue SET status = 'waiting' WHERE status IN ('preparing', 'transferring', 'retrying')");
  // Older app versions could create duplicate active rows. Preserve the
  // historical rows but mark all newer duplicates cancelled before installing
  // the partial unique index. created_at + id gives a deterministic oldest row
  // without relying on random UUID ordering alone.
  await db.execAsync(`
    UPDATE transfer_queue
    SET status = 'cancelled', last_error = 'duplicate_coalesced'
    WHERE id IN (
      SELECT duplicate.id FROM transfer_queue AS duplicate
      WHERE duplicate.status IN ('waiting', 'preparing', 'transferring', 'retrying', 'failed')
        AND duplicate.target_room_id IS NOT NULL
        AND duplicate.target_desktop_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM transfer_queue AS oldest
          WHERE oldest.uri = duplicate.uri
            AND oldest.target_room_id = duplicate.target_room_id
            AND oldest.target_desktop_id = duplicate.target_desktop_id
            AND oldest.status IN ('waiting', 'preparing', 'transferring', 'retrying', 'failed')
            AND (oldest.created_at < duplicate.created_at
              OR (oldest.created_at = duplicate.created_at AND oldest.id < duplicate.id))
        )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS transfer_queue_active_identity
      ON transfer_queue(uri, target_room_id, target_desktop_id)
      WHERE status IN ('waiting', 'preparing', 'transferring', 'retrying', 'failed');
  `);
  return db;
}

async function database() {
  databasePromise ??= initializeDatabase();
  return databasePromise;
}

type TransferRow = { id: string; uri: string; name: string; mime: string; status: QueuedTransfer["status"]; created_at: number; last_error: string | null; target_room_id: string | null; target_desktop_id: string | null };

function fromRow(row: TransferRow): QueuedTransfer {
  const target = row.target_room_id && row.target_desktop_id ? { roomId: row.target_room_id, desktopId: row.target_desktop_id } : null;
  return { id: row.id, uri: row.uri, name: row.name, mime: row.mime, status: row.status, createdAt: row.created_at, lastError: row.last_error ?? undefined, target };
}

export async function enqueueTransfer(input: { uri: string; name: string; mime: string; target: PairingRef }): Promise<QueuedTransfer> {
  const db = await database();
  const item: QueuedTransfer = { id: crypto.randomUUID(), ...input, status: "waiting", createdAt: Date.now() };
  let result: QueuedTransfer = item;
  // Exclusive transactions serialize the read-before-insert operation. The
  // unique index is still the final guard if another process has an open DB.
  await db.withExclusiveTransactionAsync(async (txn) => {
    const existing = await txn.getFirstAsync<TransferRow>(
      "SELECT * FROM transfer_queue WHERE uri = ? AND target_room_id = ? AND target_desktop_id = ? AND status IN ('waiting', 'preparing', 'transferring', 'retrying', 'failed') ORDER BY created_at ASC LIMIT 1",
      input.uri, input.target.roomId, input.target.desktopId,
    );
    if (existing) {
      if (existing.status === "failed") {
        await txn.runAsync("UPDATE transfer_queue SET status = 'waiting', last_error = NULL WHERE id = ?", existing.id);
        result = { ...fromRow({ ...existing, status: "waiting", last_error: null }), deduplicated: true };
      } else result = { ...fromRow(existing), deduplicated: true };
      return;
    }
    await txn.runAsync(
      "INSERT INTO transfer_queue (id, uri, name, mime, status, created_at, target_room_id, target_desktop_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      item.id, item.uri, item.name, item.mime, item.status, item.createdAt, input.target.roomId, input.target.desktopId,
    );
  });
  return result;
}

export async function listPendingTransfers(): Promise<QueuedTransfer[]> {
  const db = await database();
  const rows = await db.getAllAsync<TransferRow>("SELECT * FROM transfer_queue WHERE status IN ('waiting', 'preparing', 'failed', 'retrying', 'transferring') ORDER BY created_at ASC");
  return rows.map(fromRow);
}

export async function assignUnassignedTransfersTarget(target: PairingRef): Promise<number> {
  const db = await database();
  let assigned = 0;
  await db.withExclusiveTransactionAsync(async (txn) => {
    const rows = await txn.getAllAsync<TransferRow>("SELECT * FROM transfer_queue WHERE status IN ('waiting', 'failed') AND (target_room_id IS NULL OR target_desktop_id IS NULL) ORDER BY created_at ASC");
    for (const row of rows) {
      const duplicate = await txn.getFirstAsync<TransferRow>(
        "SELECT * FROM transfer_queue WHERE uri = ? AND target_room_id = ? AND target_desktop_id = ? AND status IN ('waiting', 'preparing', 'transferring', 'retrying', 'failed') LIMIT 1",
        row.uri, target.roomId, target.desktopId,
      );
      if (duplicate) {
        await txn.runAsync("UPDATE transfer_queue SET status = 'cancelled', last_error = 'duplicate_coalesced' WHERE id = ?", row.id);
      } else {
        await txn.runAsync("UPDATE transfer_queue SET target_room_id = ?, target_desktop_id = ?, status = 'waiting', last_error = NULL WHERE id = ?", target.roomId, target.desktopId, row.id);
        assigned += 1;
      }
    }
  });
  return assigned;
}

export async function releaseTransfersTarget(target: PairingRef): Promise<void> {
  const db = await database();
  await db.runAsync(
    "UPDATE transfer_queue SET target_room_id = NULL, target_desktop_id = NULL, status = 'waiting', last_error = NULL WHERE status IN ('waiting', 'preparing', 'failed', 'retrying', 'transferring') AND target_room_id = ? AND target_desktop_id = ?",
    target.roomId, target.desktopId,
  );
}

export async function updateTransferStatus(id: string, status: QueuedTransfer["status"], lastError?: string): Promise<void> {
  const db = await database();
  await db.runAsync("UPDATE transfer_queue SET status = ?, last_error = ? WHERE id = ?", status, lastError ?? null, id);
}

export async function cancelTransfer(id: string): Promise<void> {
  const db = await database();
  await db.runAsync(
    "UPDATE transfer_queue SET status = 'cancelled', last_error = NULL WHERE id = ? AND status IN ('waiting', 'preparing', 'retrying', 'transferring', 'failed')",
    id,
  );
}

export async function countPendingTransfers(): Promise<number> {
  const db = await database();
  const row = await db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM transfer_queue WHERE status IN ('waiting', 'preparing', 'failed', 'retrying', 'transferring')");
  return row?.count ?? 0;
}
