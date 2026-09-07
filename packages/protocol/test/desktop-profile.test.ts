import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopProfileMessage } from "../src/index.ts";

test("desktop profile validates bounded display names separately from transfers", () => {
  const profile = { type: "desktop:profile", desktopId: "desktop-a", desktopAlias: "교무실 PC" };
  assert.deepEqual(parseDesktopProfileMessage(profile), profile);
  assert.equal(parseDesktopProfileMessage({ type: "transfer:ack" }), null);
  for (const alias of ["", " ", " PC ", "가".repeat(81)]) {
    assert.throws(() => parseDesktopProfileMessage({ ...profile, desktopAlias: alias }), /invalid_desktop_profile/);
  }
  assert.throws(() => parseDesktopProfileMessage({ ...profile, desktopId: "" }), /invalid_desktop_profile/);
});
