import { File } from "expo-file-system";
import {
  ColorConversionCodes,
  DataTypes,
  Mat,
  OpenCV,
  RotateFlags,
  Size,
  ThresholdTypes,
} from "react-native-fast-opencv";
import type { ScanImageProcessor, ScanRotation } from "@easydoc/image-processing";

function rotateFlag(rotation: Exclude<ScanRotation, 0>): RotateFlags {
  switch (rotation) {
    case 90: return RotateFlags.ROTATE_90_CLOCKWISE;
    case 180: return RotateFlags.ROTATE_180;
    case 270: return RotateFlags.ROTATE_90_COUNTERCLOCKWISE;
  }
}

function outputFormat(uri: string): "jpeg" | "png" {
  return uri.toLowerCase().endsWith(".png") ? "png" : "jpeg";
}

export const opencvScanImageProcessor: ScanImageProcessor = {
  async process(request) {
    const rotation = request.rotation ?? 0;
    if (request.filter === "color" && rotation === 0) return { uri: request.inputUri };

    const source = Mat.createFromBase64(await new File(request.inputUri).base64());
    const mats: Mat[] = [source];
    let current = source;

    try {
      if (rotation !== 0) {
        const rotated = Mat.create(0, 0, DataTypes.CV_8U);
        mats.push(rotated);
        OpenCV.rotate(current, rotated, rotateFlag(rotation));
        current = rotated;
      }

      if (request.filter !== "color") {
        const gray = Mat.create(0, 0, DataTypes.CV_8U);
        mats.push(gray);
        OpenCV.cvtColor(current, gray, ColorConversionCodes.COLOR_BGR2GRAY);
        current = gray;

        if (request.filter === "bw") {
          const blurred = Mat.create(0, 0, DataTypes.CV_8U);
          const binary = Mat.create(0, 0, DataTypes.CV_8U);
          const kernel = Size.create(3, 3);
          mats.push(blurred, binary);
          try {
            OpenCV.GaussianBlur(current, blurred, kernel, 0);
            OpenCV.threshold(
              blurred,
              binary,
              0,
              255,
              ThresholdTypes.THRESH_BINARY | ThresholdTypes.THRESH_OTSU,
            );
          } finally {
            kernel.release();
          }
          current = binary;
        }
      }

      const format = outputFormat(request.outputUri);
      current.saveToFile(
        request.outputUri,
        format,
        Math.max(0.01, Math.min(1, (request.jpegQuality ?? 90) / 100)),
      );
      return {
        uri: request.outputUri,
        mimeType: format === "png" ? "image/png" : "image/jpeg",
      };
    } finally {
      for (const mat of mats.reverse()) mat.release();
    }
  },
};
