import * as SecureStore from "expo-secure-store";
import {
  randomUUID,
  digestStringAsync,
  CryptoDigestAlgorithm,
} from "expo-crypto";
import { createCustomerClient } from "./client.ts";
import { secureRecord } from "./secure-record.ts";
import { createCommerceModel } from "../cart/model.ts";

export { randomUUID };
export async function nativeCommerce(apiUrl: string, storeSlug: string) {
  const scope = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    `${apiUrl}/${storeSlug}`,
  );
  const kv = {
    get: (key: string) => SecureStore.getItemAsync(key),
    set: (key: string, value: string) =>
      SecureStore.setItemAsync(key, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    remove: (key: string) => SecureStore.deleteItemAsync(key),
  };
  return createCommerceModel({
    client: createCustomerClient({
      apiUrl,
      storeSlug,
      fetch,
      secret: secureRecord(kv, `wo.${scope}.session`, randomUUID),
    }),
    storage: secureRecord(kv, `wo.${scope}.commerce`, randomUUID),
    uuid: randomUUID,
  });
}
