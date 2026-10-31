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
const scopeOf = (apiUrl: string, storeSlug: string) =>
  digestStringAsync(CryptoDigestAlgorithm.SHA256, `${apiUrl}/${storeSlug}`);
const kv = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  remove: (key: string) => SecureStore.deleteItemAsync(key),
};

/**
 * This installation's random id for order notifications (ADR 0027), created once and kept in
 * the secure storage. Never a hardware id; the system may keep it across a reinstall (the iOS
 * keychain does), which still names the same app on the same device.
 */
export async function nativeInstallationId(
  apiUrl: string,
  storeSlug: string,
): Promise<string> {
  const key = `wo.${await scopeOf(apiUrl, storeSlug)}.installation`;
  const saved = await kv.get(key);
  if (saved) return saved;
  const created = randomUUID();
  await kv.set(key, created);
  return created;
}

export async function nativeCommerce(apiUrl: string, storeSlug: string) {
  const scope = await scopeOf(apiUrl, storeSlug);
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
