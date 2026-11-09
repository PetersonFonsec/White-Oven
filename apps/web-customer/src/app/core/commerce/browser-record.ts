import type { SecretStore } from "@whiteoven/customer-core/customer/client";

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function commit(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite", { durability: "strict" });
    if (value === null) tx.objectStore("records").delete(key);
    else tx.objectStore("records").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
/** Caller holds the store's exclusive Web Lock through the final durable write. */
export async function browserRecords(slug: string) {
  const request = indexedDB.open("whiteoven-consumer", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("records");
  const db = await read(request);
  const get = <T>(name: string) =>
    read<T>(db.transaction("records").objectStore("records").get(name));
  try {
    const keyName = slug + "/key";
    let key = await get<CryptoKey | undefined>(keyName);
    if (!key) {
      key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await commit(db, keyName, key);
    }
    const secret = key;
    function record(kind: "session" | "cart"): SecretStore {
      const name = slug + "/" + kind;
      const additionalData = new TextEncoder().encode(name);
      return {
        async read() {
          const saved = await get<
            { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined
          >(name);
          if (saved === undefined) return null;
          return new TextDecoder().decode(
            await crypto.subtle.decrypt(
              { name: "AES-GCM", iv: saved.iv, additionalData },
              secret,
              saved.data,
            ),
          );
        },
        async write(text) {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const data = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData },
            secret,
            new TextEncoder().encode(text),
          );
          await commit(db, name, { iv, data });
        },
        remove: () => commit(db, name, null),
      };
    }
    return {
      secret: record("session"),
      storage: record("cart"),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
