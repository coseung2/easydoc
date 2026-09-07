export type CaptureMode = "capture" | "scan";

export type ScannerCameraBehavior = {
  autoSnappingEnabled: boolean;
  detectDocumentAfterSnap: boolean;
  polygonEnabled: boolean;
};

export function scannerCameraBehavior(mode: CaptureMode): ScannerCameraBehavior {
  const scanning = mode === "scan";
  return {
    autoSnappingEnabled: scanning,
    detectDocumentAfterSnap: scanning,
    polygonEnabled: scanning,
  };
}
