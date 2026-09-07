export const SECTIONS = ["settings", "inbox", "pairings"] as const;

export type Section = (typeof SECTIONS)[number];

export function sectionFromEventPayload(payload: unknown): Section | null {
  const candidate = typeof payload === "string"
    ? payload
    : payload && typeof payload === "object" && "section" in payload
      ? (payload as { section?: unknown }).section
      : undefined;

  return typeof candidate === "string" && SECTIONS.includes(candidate as Section)
    ? candidate as Section
    : null;
}

/** A dirty draft must never be replaced by a background snapshot. */
export function shouldAdoptServerAlias(draftDirty: boolean): boolean {
  return !draftDirty;
}

export function shouldApplySettingsSnapshot(generationAtStart: number, currentGeneration: number): boolean {
  return generationAtStart === currentGeneration;
}

/**
 * Small keyed gate used for both refreshes and commands. It is deliberately
 * framework-free so its duplicate/overlap semantics can be tested directly.
 */
export function createKeyedGate() {
  const active = new Set<string>();

  return {
    tryStart(key: string) {
      if (active.has(key)) return false;
      active.add(key);
      return true;
    },
    finish(key: string) {
      active.delete(key);
    },
    isActive(key: string) {
      return active.has(key);
    },
  };
}
