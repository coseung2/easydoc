import assert from "node:assert/strict";
import test from "node:test";
import { ResponseTimeoutController, type TimeoutClock } from "../src/transfer/timeout-controller.ts";

class FakeClock implements TimeoutClock {
  private nextId = 1;
  private now = 0;
  private jobs = new Map<number, { at: number; handler: () => void }>();

  setTimeout(handler: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.now + delayMs, handler });
    return id;
  }

  clearTimeout(handle: unknown): void { this.jobs.delete(Number(handle)); }

  advance(ms: number): void {
    this.now += ms;
    for (const [id, job] of [...this.jobs].sort((a, b) => a[1].at - b[1].at)) {
      if (job.at <= this.now) { this.jobs.delete(id); job.handler(); }
    }
  }
}

test("response timeout can be restarted and cancelled under a fake clock", () => {
  const clock = new FakeClock();
  let timeouts = 0;
  const controller = new ResponseTimeoutController(100, () => { timeouts += 1; }, clock);
  controller.arm();
  clock.advance(99);
  assert.equal(timeouts, 0);
  controller.arm();
  clock.advance(1);
  assert.equal(timeouts, 0);
  clock.advance(99);
  assert.equal(timeouts, 1);
  controller.clear();
  clock.advance(500);
  assert.equal(timeouts, 1);
});
