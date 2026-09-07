export type DesktopProfileMessage = {
  type: "desktop:profile";
  desktopId: string;
  desktopAlias: string;
};

/** Metadata is separate from transfer controls: it must never settle a transfer. */
export function parseDesktopProfileMessage(value: unknown): DesktopProfileMessage | null {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "desktop:profile") return null;
  const message = value as Record<string, unknown>;
  if (typeof message.desktopId !== "string" || !message.desktopId || message.desktopId.length > 256
    || typeof message.desktopAlias !== "string" || !message.desktopAlias.trim()
    || [...message.desktopAlias].length > 80 || message.desktopAlias !== message.desktopAlias.trim()) {
    throw new Error("invalid_desktop_profile");
  }
  return { type: "desktop:profile", desktopId: message.desktopId, desktopAlias: message.desktopAlias };
}
