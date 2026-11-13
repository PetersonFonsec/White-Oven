import { createEnvironmentInjector, EnvironmentInjector } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { OPEN_SHOP_RECORDS, Shop } from "./shop";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { open, promise };
}
describe("shop lock lifetime", () => {
  let held = false;
  const writeStarted = gate(),
    finishWrite = gate();
  function tab(saved: string | null) {
    const close = vi.fn();
    const records = {
      close,
      secret: {
        read: async () => saved,
        remove: async () => {},
        write: async () => {},
      },
      storage: {
        read: async () => null,
        remove: async () => {},
        write: async () => {
          writeStarted.open();
          await finishWrite.promise;
        },
      },
    };
    const injector = createEnvironmentInjector(
      [Shop, { provide: OPEN_SHOP_RECORDS, useValue: async () => records }],
      TestBed.inject(EnvironmentInjector),
    );
    return {
      shop: injector.get(Shop),
      close,
      destroy: () => injector.destroy(),
    };
  }
  beforeEach(() => {
    held = false;
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          run: (lock: object | null) => Promise<void>,
        ) => {
          if (held) return run(null);
          held = true;
          try {
            await run({});
          } finally {
            held = false;
          }
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([false, true])(
    "drains restoration before handing off the lock (network failure %s)",
    async (fail) => {
      const started = gate();
      vi.stubGlobal(
        "fetch",
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            started.open();
            if (fail) reject(new TypeError("offline"));
            else
              init.signal!.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
          }),
      );
      const first = tab("saved"),
        second = tab(null);
      const lifetime = first.shop.start("test-store");
      await started.promise;
      await second.shop.start("test-store");
      expect(second.shop.problem()).toContain("outra aba");
      first.destroy();
      await lifetime;
      expect(first.close).toHaveBeenCalledOnce();
      const next = second.shop.start("test-store");
      await vi.waitFor(() =>
        expect(second.shop.state()?.session).toBe("restored"),
      );
      second.destroy();
      await next;
      expect(held).toBe(false);
    },
  );
  it("retains exclusivity until an already started cart write finishes", async () => {
    const first = tab(null),
      second = tab(null);
    const lifetime = first.shop.start("test-store");
    await vi.waitFor(() => expect(first.shop.state()?.busy).toBe(false));
    const write = first.shop.model!.changeCart(() => []);
    await writeStarted.promise;
    first.destroy();
    await second.shop.start("test-store");
    expect(second.shop.problem()).toContain("outra aba");
    expect(first.close).not.toHaveBeenCalled();
    finishWrite.open();
    expect(await write).toBe(true);
    await lifetime;
    expect(first.close).toHaveBeenCalledOnce();
    expect(held).toBe(false);
    second.destroy();
  });
});
