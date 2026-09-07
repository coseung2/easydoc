import ScanbotSDK, { SdkConfiguration } from "react-native-scanbot-sdk";

let initialization: Promise<void> | null = null;

export function initializeDocumentScannerSdk(): Promise<void> {
  if (!initialization) {
    const licenseKey = process.env.EXPO_PUBLIC_SCANBOT_LICENSE_KEY?.trim() ?? "";
    initialization = ScanbotSDK.initialize(new SdkConfiguration({
      licenseKey,
      storageImageFormat: "JPG",
      storageImageQuality: 95,
      loggingEnabled: __DEV__,
    })).then(() => undefined).catch((error) => {
      initialization = null;
      throw error;
    });
  }
  return initialization;
}
