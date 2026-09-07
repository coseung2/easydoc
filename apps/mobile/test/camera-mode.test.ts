import assert from "node:assert/strict";
import test from "node:test";
import { scannerCameraBehavior } from "../src/scanner/camera-mode.ts";

test("capture mode disables document detection and auto snapping", () => {
  assert.deepEqual(scannerCameraBehavior("capture"), {
    autoSnappingEnabled: false,
    detectDocumentAfterSnap: false,
    polygonEnabled: false,
  });
});

test("scan mode enables document detection, polygon, and auto snapping", () => {
  assert.deepEqual(scannerCameraBehavior("scan"), {
    autoSnappingEnabled: true,
    detectDocumentAfterSnap: true,
    polygonEnabled: true,
  });
});
