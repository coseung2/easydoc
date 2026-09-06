type DecoderOptions = { fatal?: boolean; ignoreBOM?: boolean };
type DecodeOptions = { stream?: boolean };
type DecoderInput = ArrayBuffer | ArrayBufferView;
type Decoder = {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: DecoderInput, options?: DecodeOptions): string;
};
type DecoderConstructor = new (label?: string, options?: DecoderOptions) => Decoder;

const latin1Labels = new Set(["binary", "iso-8859-1", "iso8859-1", "latin1"]);

export function installLatin1TextDecoderPolyfill(target: { TextDecoder: DecoderConstructor }): void {
  const NativeTextDecoder = target.TextDecoder;
  try {
    new NativeTextDecoder("latin1");
    return;
  } catch {
    // fast-png 초기화에 필요한 latin1 디코더가 없는 런타임만 보완한다.
  }

  class CompatibleTextDecoder implements Decoder {
    readonly encoding: string;
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;
    private readonly native?: Decoder;

    constructor(label = "utf-8", options: DecoderOptions = {}) {
      const normalized = label.trim().toLowerCase();
      this.fatal = options.fatal ?? false;
      this.ignoreBOM = options.ignoreBOM ?? false;
      if (latin1Labels.has(normalized)) {
        this.encoding = "iso-8859-1";
      } else {
        this.native = new NativeTextDecoder(label, options);
        this.encoding = this.native.encoding;
      }
    }

    decode(input?: DecoderInput, options?: DecodeOptions): string {
      if (this.native) return this.native.decode(input, options);
      if (!input) return "";
      const bytes = input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let output = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        output += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      return output;
    }
  }

  target.TextDecoder = CompatibleTextDecoder;
}

installLatin1TextDecoderPolyfill(globalThis as unknown as { TextDecoder: DecoderConstructor });
