import assert from "node:assert/strict";
import test from "node:test";
import { runMilestone0FileTransfer } from "../scripts/milestone0-file-transfer.ts";

test("file-backed Milestone 0 harness transfers 1 MiB through bounded relay frames", async () => {
  const result = await runMilestone0FileTransfer(1024 * 1024, 64 * 1024);
  assert.equal(result.sizeBytes, 1024 * 1024);
  assert.equal(result.chunks, 16);
  assert.ok(result.peakInFlightBytes <= 8 * 1024 * 1024);
  assert.match(result.sha256, /^[0-9a-f]{64}$/u);
});
