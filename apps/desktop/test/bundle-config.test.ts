import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const tauriRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri");

test("desktop bundle declares existing Windows and macOS icons", async () => {
  const config = JSON.parse(await readFile(path.join(tauriRoot, "tauri.conf.json"), "utf8"));
  const icons = config.bundle?.icon;

  assert.ok(Array.isArray(icons), "bundle.icon must be configured");
  assert.ok(icons.some((icon: string) => icon.endsWith(".ico")), "Windows bundles require an .ico icon");
  assert.ok(icons.some((icon: string) => icon.endsWith(".icns")), "macOS bundles require an .icns icon");

  await Promise.all(icons.map((icon: string) => access(path.resolve(tauriRoot, icon))));
});
