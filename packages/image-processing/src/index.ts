import { decode as decodePng, encode as encodePng, hasPngSignature } from "fast-png";
import jpeg from "jpeg-js";

export type ScanFilter = "color" | "gray" | "bw";
export type ProcessedImage = { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png"; width: number; height: number };

type Raster = { data: Uint8Array; width: number; height: number; mimeType: "image/jpeg" | "image/png" };

function decodeImage(input: Uint8Array): Raster {
  if (hasPngSignature(input)) {
    const image = decodePng(input);
    const rgba = new Uint8Array(image.width * image.height * 4);
    const channels = image.channels;
    for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
      const source = pixel * channels;
      const target = pixel * 4;
      if (channels === 4) {
        rgba[target] = Number(image.data[source]); rgba[target + 1] = Number(image.data[source + 1]); rgba[target + 2] = Number(image.data[source + 2]); rgba[target + 3] = Number(image.data[source + 3]);
      } else if (channels === 3) {
        rgba[target] = Number(image.data[source]); rgba[target + 1] = Number(image.data[source + 1]); rgba[target + 2] = Number(image.data[source + 2]); rgba[target + 3] = 255;
      } else if (channels === 2) {
        const value = Number(image.data[source]); rgba[target] = value; rgba[target + 1] = value; rgba[target + 2] = value; rgba[target + 3] = Number(image.data[source + 1]);
      } else {
        const value = Number(image.data[source]); rgba[target] = value; rgba[target + 1] = value; rgba[target + 2] = value; rgba[target + 3] = 255;
      }
    }
    return { data: rgba, width: image.width, height: image.height, mimeType: "image/png" };
  }
  const image = jpeg.decode(input, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 80, maxMemoryUsageInMB: 512 });
  return { data: Uint8Array.from(image.data), width: image.width, height: image.height, mimeType: "image/jpeg" };
}

function luminance(r: number, g: number, b: number): number { return Math.round(0.299 * r + 0.587 * g + 0.114 * b); }

export function otsuThreshold(rgba: Uint8Array): number {
  const histogram = new Uint32Array(256); let total = 0; let sum = 0;
  for (let index = 0; index + 3 < rgba.length; index += 4) { const value = luminance(rgba[index]!, rgba[index + 1]!, rgba[index + 2]!); histogram[value]! += 1; total += 1; sum += value; }
  let backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, threshold = 160;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value]!; if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight; if (foregroundWeight === 0) break;
    backgroundSum += value * histogram[value]!;
    const meanBackground = backgroundSum / backgroundWeight; const meanForeground = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) { bestVariance = variance; threshold = value; }
  }
  return threshold;
}

export function applyFilterToRgba(rgba: Uint8Array, filter: ScanFilter): Uint8Array {
  if (filter === "color") return rgba.slice();
  const output = rgba.slice(); const threshold = filter === "bw" ? otsuThreshold(rgba) : 0;
  for (let index = 0; index + 3 < output.length; index += 4) {
    const gray = luminance(output[index]!, output[index + 1]!, output[index + 2]!);
    const value = filter === "bw" ? (gray >= threshold ? 255 : 0) : gray;
    output[index] = value; output[index + 1] = value; output[index + 2] = value;
  }
  return output;
}

export function processImage(input: Uint8Array, filter: ScanFilter, jpegQuality = 90): ProcessedImage {
  const image = decodeImage(input); if (filter === "color") return { bytes: input.slice(), mimeType: image.mimeType, width: image.width, height: image.height };
  const data = applyFilterToRgba(image.data, filter);
  if (image.mimeType === "image/png") return { bytes: encodePng({ data, width: image.width, height: image.height, channels: 4, depth: 8 }), mimeType: "image/png", width: image.width, height: image.height };
  const encoded = jpeg.encode({ data, width: image.width, height: image.height }, Math.max(1, Math.min(100, jpegQuality)));
  return { bytes: Uint8Array.from(encoded.data), mimeType: "image/jpeg", width: image.width, height: image.height };
}
