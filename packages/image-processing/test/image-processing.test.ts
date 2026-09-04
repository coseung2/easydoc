import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode } from "fast-png";
import { applyFilterToRgba, otsuThreshold, processImage } from "../src/index.ts";

const rgba = Uint8Array.from([
  240, 120, 10, 255,
  20, 40, 220, 255,
  255, 255, 255, 255,
  0, 0, 0, 255,
]);

test("grayscale makes RGB channels equal while preserving alpha", () => {
  const result = applyFilterToRgba(rgba, "gray");
  for (let index = 0; index < result.length; index += 4) { assert.equal(result[index], result[index + 1]); assert.equal(result[index + 1], result[index + 2]); assert.equal(result[index + 3], 255); }
});

test("black and white uses a computed threshold and produces binary pixels", () => {
  const threshold = otsuThreshold(rgba); assert.ok(threshold >= 0 && threshold <= 255);
  const result = applyFilterToRgba(rgba, "bw");
  for (let index = 0; index < result.length; index += 4) assert.ok(result[index] === 0 || result[index] === 255);
});

test("PNG filtering re-encodes a valid same-size image", () => {
  const png = encode({ data: rgba, width: 2, height: 2, channels: 4, depth: 8 });
  const output = processImage(png, "gray");
  const decoded = decode(output.bytes);
  assert.equal(output.mimeType, "image/png"); assert.equal(decoded.width, 2); assert.equal(decoded.height, 2);
});
