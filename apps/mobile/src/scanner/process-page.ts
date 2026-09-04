import { Directory, File, Paths } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { processImage, type ScanFilter } from "@easydoc/image-processing";

export type EditableScanPage = {
  id: string;
  uri: string;
  rotation: 0 | 90 | 180 | 270;
  filter: ScanFilter;
};

export async function prepareScanPage(page: EditableScanPage): Promise<string> {
  let workingUri = page.uri;

  if (page.rotation !== 0) {
    const rotated = await manipulateAsync(
      workingUri,
      [{ rotate: page.rotation }],
      { compress: 0.95, format: SaveFormat.JPEG },
    );
    workingUri = rotated.uri;
  }

  if (page.filter === "color") return workingUri;

  const source = new File(workingUri);
  const processed = processImage(await source.bytes(), page.filter, 92);
  const cacheDirectory = new Directory(Paths.cache, "EasyDoc", "processed-scans");
  cacheDirectory.create({ intermediates: true, idempotent: true });
  const extension = processed.mimeType === "image/png" ? "png" : "jpg";
  const target = new File(cacheDirectory, `${page.id}-${page.rotation}-${page.filter}.${extension}`);
  target.create({ overwrite: true, intermediates: true });
  target.write(processed.bytes);
  return target.uri;
}

export function rotateScanPage(page: EditableScanPage): EditableScanPage {
  const rotation = ((page.rotation + 90) % 360) as EditableScanPage["rotation"];
  return { ...page, rotation };
}
