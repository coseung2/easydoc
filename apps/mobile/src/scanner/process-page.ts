import { Directory, File, Paths } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { createJsScanImageProcessor, type ScanFilter, type ScanImageProcessor } from "@easydoc/image-processing";

export type EditableScanPage = {
  id: string;
  uri: string;
  rotation: 0 | 90 | 180 | 270;
  filter: ScanFilter;
};

const jsScanImageProcessor = createJsScanImageProcessor({
  read: async (uri) => new File(uri).bytes(),
  write: async (uri, bytes) => {
    const target = new File(uri);
    target.create({ overwrite: true, intermediates: true });
    target.write(bytes);
  },
  rotate: async (uri, rotation, jpegQuality) => {
    const rotated = await manipulateAsync(
      uri,
      [{ rotate: rotation }],
      { compress: jpegQuality / 100, format: SaveFormat.JPEG },
    );
    return rotated.uri;
  },
});

async function selectedScanImageProcessor(): Promise<ScanImageProcessor> {
  if (process.env.EXPO_PUBLIC_SCAN_IMAGE_BACKEND === "opencv") {
    const { opencvScanImageProcessor } = await import("./opencv-image-processor.ts");
    return opencvScanImageProcessor;
  }
  return jsScanImageProcessor;
}

export async function prepareScanPage(page: EditableScanPage, processor?: ScanImageProcessor): Promise<string> {
  if (page.filter === "color" && page.rotation === 0) return page.uri;

  const source = new File(page.uri);
  const cacheDirectory = new Directory(Paths.cache, "EasyDoc", "processed-scans");
  cacheDirectory.create({ intermediates: true, idempotent: true });
  const sourceExtension = source.extension.toLowerCase();
  const extension = page.rotation === 0 && sourceExtension.endsWith(".png") ? "png" : "jpg";
  const target = new File(cacheDirectory, `${page.id}-${page.rotation}-${page.filter}.${extension}`);
  const activeProcessor = processor ?? await selectedScanImageProcessor();
  const result = await activeProcessor.process({
    inputUri: page.uri,
    outputUri: target.uri,
    filter: page.filter,
    rotation: page.rotation,
    jpegQuality: 92,
  });
  return result.uri;
}

export function rotateScanPage(page: EditableScanPage): EditableScanPage {
  const rotation = ((page.rotation + 90) % 360) as EditableScanPage["rotation"];
  return { ...page, rotation };
}
