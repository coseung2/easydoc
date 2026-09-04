import assert from "node:assert/strict";
import test from "node:test";
import { installLatin1TextDecoderPolyfill } from "../src/polyfills/text-decoder.ts";

test("adds latin1 decoding when the native runtime only supports UTF-8", () => {
  class Utf8OnlyTextDecoder {
    readonly encoding = "utf-8";
    readonly fatal = false;
    readonly ignoreBOM = false;

    constructor(label = "utf-8") {
      if (label.toLowerCase() !== "utf-8") throw new RangeError(`Unknown encoding: ${label}`);
    }

    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return "";
      const bytes = input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      return String.fromCharCode(...bytes);
    }
  }

  const target = { TextDecoder: Utf8OnlyTextDecoder };
  installLatin1TextDecoderPolyfill(target);

  const decoder = new target.TextDecoder("latin1");
  assert.equal(decoder.encoding, "iso-8859-1");
  assert.equal(decoder.decode(Uint8Array.from([0x41, 0xe9])), "Aé");
});
