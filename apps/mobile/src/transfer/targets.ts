import { pairingRefKey, type PairingRef } from "../../../../packages/protocol/src/index.ts";

export function groupTransfersByTarget<T extends { target: PairingRef | null }>(items: readonly T[]): { byTarget: Map<string, T[]>; unassigned: T[] } {
  const byTarget = new Map<string, T[]>();
  const unassigned: T[] = [];
  for (const item of items) {
    if (!item.target) {
      unassigned.push(item);
      continue;
    }
    const key = pairingRefKey(item.target);
    const group = byTarget.get(key) ?? [];
    group.push(item);
    byTarget.set(key, group);
  }
  return { byTarget, unassigned };
}
