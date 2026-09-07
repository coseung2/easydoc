import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode } from "fast-png";
import { applyFilterToRgba, createJsScanImageProcessor, otsuThreshold, processImage } from "../src/index.ts";

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

test("JS scan processor keeps color input untouched when no rotation is requested", async () => {
  let reads = 0; let writes = 0;
  const processor = createJsScanImageProcessor({
    read: async () => { reads += 1; return rgba; },
    write: async () => { writes += 1; },
  });
  const result = await processor.process({ inputUri: "input.jpg", outputUri: "output.jpg", filter: "color" });
  assert.equal(result.uri, "input.jpg"); assert.equal(reads, 0); assert.equal(writes, 0);
});

test("JS scan processor applies rotation before filtering and writes the requested output", async () => {
  const png = encode({ data: rgba, width: 2, height: 2, channels: 4, depth: 8 });
  const files = new Map<string, Uint8Array>([["rotated.jpg", png]]);
  const calls: string[] = [];
  const processor = createJsScanImageProcessor({
    read: async (uri) => { calls.push(`read:${uri}`); return files.get(uri)!; },
    write: async (uri, bytes) => { calls.push(`write:${uri}`); files.set(uri, bytes); },
    rotate: async (uri, rotation) => { calls.push(`rotate:${uri}:${rotation}`); return "rotated.jpg"; },
  });
  const result = await processor.process({ inputUri: "input.jpg", outputUri: "output.png", filter: "gray", rotation: 90, jpegQuality: 92 });
  assert.deepEqual(calls, ["rotate:input.jpg:90", "read:rotated.jpg", "write:output.png"]);
  assert.equal(result.uri, "output.png"); assert.equal(result.mimeType, "image/png");
  assert.equal(decode(files.get("output.png")!).width, 2);
});
