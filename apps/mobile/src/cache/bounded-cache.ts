/**
 * Small in-memory LRU cache for values which may be expensive to produce.
 *
 * A pending load is shared by all callers (single-flight), while rejected
 * loads are removed immediately so a later call can retry. Values are bounded
 * by both entry count and an estimated weight (normally bytes).
 */
export type BoundedCacheOptions<T> = {
  maxEntries: number;
  maxWeight: number;
  weightOf?: (value: T) => number;
  onDelete?: (value: T, key: string) => void;
};

type Entry<T> = { value: T; weight: number };

export class BoundedAsyncCache<T> {
  private readonly options: BoundedCacheOptions<T>;
  private readonly entries = new Map<string, Entry<T>>();
  private readonly pending = new Map<string, Promise<T>>();
  private readonly weightOf: (value: T) => number;
  private readonly onDelete?: (value: T, key: string) => void;
  private weight = 0;

  constructor(options: BoundedCacheOptions<T>) {
    this.options = options;
    this.weightOf = options.weightOf ?? (() => 1);
    this.onDelete = options.onDelete;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Map insertion order is the recency order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, weight = this.weightOf(value)): void {
    this.remove(key);
    const normalizedWeight = Math.max(0, Number.isFinite(weight) ? weight : 0);
    if (this.options.maxEntries <= 0 || normalizedWeight > this.options.maxWeight) {
      // Resource values (for example temporary image files) still need to be
      // disposed when they cannot fit in the configured bound.
      this.onDelete?.(value, key);
      return;
    }
    this.entries.set(key, { value, weight: normalizedWeight });
    this.weight += normalizedWeight;
    this.evict();
  }

  async getOrLoad(key: string, loader: () => Promise<T> | T, weight?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(key);
    if (existing) return existing;

    // Defer invocation until the pending entry is registered, including loaders
    // that throw synchronously. Identity also isolates invalidation per key.
    const pending = Promise.resolve().then(loader).then((value) => {
      if (this.pending.get(key) === pending) this.set(key, value, weight);
      return value;
    }).finally(() => {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    });
    this.pending.set(key, pending);
    return pending;
  }

  remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.weight -= entry.weight;
    this.onDelete?.(entry.value, key);
    return true;
  }

  invalidateWhere(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (predicate(key) && this.remove(key)) removed += 1;
    }
    for (const key of Array.from(this.pending.keys())) {
      if (predicate(key)) {
        this.pending.delete(key);
      }
    }
    return removed;
  }

  clear(): void {
    this.pending.clear();
    for (const key of Array.from(this.entries.keys())) this.remove(key);
  }

  get size(): number { return this.entries.size; }
  get totalWeight(): number { return this.weight; }

  private evict(): void {
    while (this.entries.size > this.options.maxEntries || this.weight > this.options.maxWeight) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
  }
}
