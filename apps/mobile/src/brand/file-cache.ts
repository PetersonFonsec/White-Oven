import { File, Paths } from "expo-file-system";
import type { BrandCache } from "./store-loader.ts";

/**
 * The brand cache in the app's document directory, one file per store. It holds only the public
 * profile (name and colors): no token or personal data ever goes here.
 */
export function fileBrandCache(storeSlug: string): BrandCache {
  const file = new File(Paths.document, `whiteoven-brand-${storeSlug}.json`);
  return {
    async read() {
      return file.exists ? file.text() : null;
    },
    write(value) {
      return file.write(value);
    },
  };
}
