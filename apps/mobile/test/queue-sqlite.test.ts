import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("real SQLite queue migration, concurrent dedup, reassignment and terminal cancellation", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`CREATE TABLE transfer_queue (
    id TEXT PRIMARY KEY, uri TEXT, name TEXT, mime TEXT, status TEXT,
    created_at INTEGER, last_error TEXT, target_room_id TEXT, target_desktop_id TEXT
  );
  INSERT INTO transfer_queue VALUES
    ('old', 'file://legacy', 'old.pdf', 'application/pdf', 'transferring', 1, NULL, 'room', 'pc'),
    ('new', 'file://legacy', 'old.pdf', 'application/pdf', 'waiting', 2, NULL, 'room', 'pc');`);
  const native = {
    async execAsync(statement: string) { sql.exec(statement); },
    async runAsync(statement: string, ...args: (string | number | null)[]) { return sql.prepare(statement).run(...args); },
    async getAllAsync(statement: string, ...args: (string | number | null)[]) { return sql.prepare(statement).all(...args); },
    async getFirstAsync(statement: string, ...args: (string | number | null)[]) { return sql.prepare(statement).get(...args) ?? null; },
    async withExclusiveTransactionAsync(operation: (txn: unknown) => Promise<void>) {
      sql.exec("BEGIN IMMEDIATE");
      try { await operation(native); sql.exec("COMMIT"); }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  // Only replace Expo's native transport, not queue logic or SQL semantics.
  const globals = globalThis as typeof globalThis & { __queueTestDb?: typeof native };
  globals.__queueTestDb = native;
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === "expo-sqlite") return { shortCircuit: true, url: "data:text/javascript,export async function openDatabaseAsync(){return globalThis.__queueTestDb}" };
    return nextResolve(specifier, context);
  } });
  try {
    const queue = await import("../src/transfer/queue.ts");
    const migrated = await queue.listPendingTransfers();
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].id, "old");
    assert.equal(migrated[0].status, "waiting");
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM transfer_queue").get()?.n, 2);
    assert.equal(sql.prepare("SELECT status FROM transfer_queue WHERE id='new'").get()?.status, "cancelled");
    const input = { uri: "file://new", name: "새 파일.pdf", mime: "application/pdf", target: { roomId: "room", desktopId: "pc" } };
    const [first, second] = await Promise.all([queue.enqueueTransfer(input), queue.enqueueTransfer(input)]);
    assert.equal(first.id, second.id);
    assert.equal(second.deduplicated, true);
    const otherTarget = { roomId: "other", desktopId: "other-pc" };
    const other = await queue.enqueueTransfer({ ...input, target: otherTarget });
    await queue.releaseTransfersTarget(otherTarget);
    assert.equal(await queue.assignUnassignedTransfersTarget(input.target), 0);
    assert.equal(sql.prepare("SELECT status FROM transfer_queue WHERE id=?").get(other.id)?.status, "cancelled");
    await queue.cancelTransfer(first.id);
    await queue.updateTransferStatus(first.id, "failed", "late_network_failure");
    assert.equal(sql.prepare("SELECT status FROM transfer_queue WHERE id=?").get(first.id)?.status, "cancelled");
    const retry = await queue.enqueueTransfer(input);
    assert.notEqual(retry.id, first.id);
  } finally {
    hooks.deregister();
    delete globals.__queueTestDb;
    sql.close();
  }
});
