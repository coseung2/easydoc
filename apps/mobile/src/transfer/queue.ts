import * as SQLite from "expo-sqlite";
import type { PairingRef } from "../../../../packages/protocol/src/index.ts";

export type QueuedTransfer = {
  id: string;
  uri: string;
  name: string;
  mime: string;
  status: "waiting" | "transferring" | "failed" | "completed";
  createdAt: number;
  lastError?: string;
  target: PairingRef | null;
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
  await db.runAsync("UPDATE transfer_queue SET status = 'waiting' WHERE status = 'transferring'");
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
  await db.runAsync(
    "INSERT INTO transfer_queue (id, uri, name, mime, status, created_at, target_room_id, target_desktop_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    item.id, item.uri, item.name, item.mime, item.status, item.createdAt, input.target.roomId, input.target.desktopId,
  );
  return item;
}

export async function listPendingTransfers(): Promise<QueuedTransfer[]> {
  const db = await database();
  const rows = await db.getAllAsync<TransferRow>("SELECT * FROM transfer_queue WHERE status IN ('waiting', 'failed', 'transferring') ORDER BY created_at ASC");
  return rows.map(fromRow);
}

export async function assignUnassignedTransfersTarget(target: PairingRef): Promise<number> {
  const db = await database();
  const result = await db.runAsync(
    "UPDATE transfer_queue SET target_room_id = ?, target_desktop_id = ?, status = 'waiting', last_error = NULL WHERE status IN ('waiting', 'failed') AND (target_room_id IS NULL OR target_desktop_id IS NULL)",
    target.roomId, target.desktopId,
  );
  return result.changes;
}

export async function releaseTransfersTarget(target: PairingRef): Promise<void> {
  const db = await database();
  await db.runAsync(
    "UPDATE transfer_queue SET target_room_id = NULL, target_desktop_id = NULL, status = 'waiting', last_error = NULL WHERE status IN ('waiting', 'failed', 'transferring') AND target_room_id = ? AND target_desktop_id = ?",
    target.roomId, target.desktopId,
  );
}

export async function updateTransferStatus(id: string, status: QueuedTransfer["status"], lastError?: string): Promise<void> {
  const db = await database();
  await db.runAsync("UPDATE transfer_queue SET status = ?, last_error = ? WHERE id = ?", status, lastError ?? null, id);
}

export async function countPendingTransfers(): Promise<number> {
  const db = await database();
  const row = await db.getFirstAsync<{ count: number }>("SELECT COUNT(*) AS count FROM transfer_queue WHERE status IN ('waiting', 'failed', 'transferring')");
  return row?.count ?? 0;
}
