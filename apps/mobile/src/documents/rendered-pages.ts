import { File, Paths } from "expo-file-system";

export function discardRenderedPages(uris: readonly string[]): void {
  for (const uri of uris) {
    try {
      const file = new File(uri);
      if (file.uri.startsWith(Paths.cache.uri) && file.exists) file.delete();
    } catch {
      console.warn("EasyDoc: temporary page cleanup failed");
    }
  }
}
