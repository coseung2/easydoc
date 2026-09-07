export type TimeoutClock = {
  setTimeout: (handler: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultClock: TimeoutClock = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A restartable response timer with an injectable clock for deterministic QA. */
export class ResponseTimeoutController {
  private handle: unknown = null;
  private readonly delayMs: number;
  private readonly onTimeout: () => void;
  private readonly clock: TimeoutClock;

  constructor(
    delayMs: number,
    onTimeout: () => void,
    clock: TimeoutClock = defaultClock,
  ) {
    this.delayMs = delayMs;
    this.onTimeout = onTimeout;
    this.clock = clock;
  }

  arm(): void {
    this.clear();
    this.handle = this.clock.setTimeout(this.onTimeout, this.delayMs);
  }

  clear(): void {
    if (this.handle === null) return;
    this.clock.clearTimeout(this.handle);
    this.handle = null;
  }
}
