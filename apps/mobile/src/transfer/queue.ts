import * as SQLite from "expo-sqlite";

export type QueuedTransfer = {
  id: string;
  uri: string;
  name: string;
  mime: string;
  status: "waiting" | "transferring" | "failed" | "completed";
  createdAt: number;
  lastError?: string;
};

let databasePromise: ReturnType<typeof SQLite.openDatabaseAsync> | null = null;

async function database() {
  databasePromise ??= SQLite.openDatabaseAsync("easydoc.db");
  const db = await databasePromise;
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS transfer_queue (
      id TEXT PRIMARY KEY NOT NULL,
      uri TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_error TEXT
    );
  `);
  return db;
}

function fromRow(row: { id: string; uri: string; name: string; mime: string; status: QueuedTransfer["status"]; created_at: number; last_error: string | null }): QueuedTransfer {
  return { id: row.id, uri: row.uri, name: row.name, mime: row.mime, status: row.status, createdAt: row.created_at, lastError: row.last_error ?? undefined };
}

export async function enqueueTransfer(input: { uri: string; name: string; mime: string }): Promise<QueuedTransfer> {
  const db = await database();
  const item: QueuedTransfer = { id: crypto.randomUUID(), ...input, status: "waiting", createdAt: Date.now() };
  await db.runAsync("INSERT INTO transfer_queue (id, uri, name, mime, status, created_at) VALUES (?, ?, ?, ?, ?, ?)", item.id, item.uri, item.name, item.mime, item.status, item.createdAt);
  return item;
}

export async function listPendingTransfers(): Promise<QueuedTransfer[]> {
  const db = await database();
  await db.runAsync("UPDATE transfer_queue SET status = 'waiting' WHERE status = 'transferring'");
  const rows = await db.getAllAsync<{ id: string; uri: string; name: string; mime: string; status: QueuedTransfer["status"]; created_at: number; last_error: string | null }>("SELECT * FROM transfer_queue WHERE status IN ('waiting', 'failed', 'transferring') ORDER BY created_at ASC");
  return rows.map(fromRow);
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
