import { browserRecords } from "./browser-record";

it("keeps a failed write pending until IndexedDB finishes aborting its transaction", async () => {
  const tx = new EventTarget() as IDBTransaction;
  const failure = new DOMException("Quota exceeded", "QuotaExceededError");
  Object.assign(tx, {
    error: failure,
    objectStore: () => ({ delete: vi.fn() }),
  });
  const keyRequest = { result: {}, onsuccess: () => {} };
  const db = {
    close: vi.fn(),
    transaction: (_name: string, mode?: string) =>
      mode === "readwrite"
        ? tx
        : {
            objectStore: () => ({
              get: () => {
                queueMicrotask(() => keyRequest.onsuccess());
                return keyRequest;
              },
            }),
          },
  };
  const open = { result: db, onsuccess: () => {} };
  vi.stubGlobal("indexedDB", {
    open: () => {
      queueMicrotask(() => open.onsuccess());
      return open;
    },
  });
  try {
    const records = await browserRecords("test-store");
    const rejected = vi.fn();
    const write = records.storage.remove().catch(rejected);
    tx.onerror?.call(tx, new Event("error"));
    await Promise.resolve();
    expect(rejected).not.toHaveBeenCalled();
    tx.onabort!.call(tx, new Event("abort"));
    await write;
    expect(rejected).toHaveBeenCalledWith(failure);
    records.close();
  } finally {
    vi.unstubAllGlobals();
  }
});
