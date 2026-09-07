import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedGate, sectionFromEventPayload, shouldAdoptServerAlias } from "../ui/state.ts";

test("section events only target a known independent snapshot", () => {
  assert.equal(sectionFromEventPayload({ section: "settings" }), "settings");
  assert.equal(sectionFromEventPayload({ section: "inbox" }), "inbox");
  assert.equal(sectionFromEventPayload({ section: "pairings" }), "pairings");
  assert.equal(sectionFromEventPayload("inbox"), "inbox");
  assert.equal(sectionFromEventPayload({ section: "unknown" }), null);
  assert.equal(sectionFromEventPayload({}), null);
  assert.equal(sectionFromEventPayload(null), null);
});

test("dirty, including empty, drafts are preserved during refresh", () => {
  assert.equal(shouldAdoptServerAlias(false), true);
  assert.equal(shouldAdoptServerAlias(true), false);
});

test("keyed gate prevents duplicate commands and overlapping section refreshes", () => {
  const gate = createKeyedGate();
  assert.equal(gate.tryStart("settings"), true);
  assert.equal(gate.tryStart("settings"), false);
  assert.equal(gate.isActive("settings"), true);
  assert.equal(gate.tryStart("inbox"), true);
  gate.finish("settings");
  assert.equal(gate.tryStart("settings"), true);
  gate.finish("settings");
  gate.finish("inbox");
  assert.equal(gate.isActive("settings"), false);
  assert.equal(gate.isActive("inbox"), false);
});
