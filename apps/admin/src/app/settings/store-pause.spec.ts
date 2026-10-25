import { type ComponentFixture, TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { Session } from "../core/session";
import type { StorePause } from "./store-api";
import { StoreApi } from "./store-api";
import {
  PAUSE_EXPIRY_MARGIN_MS,
  PAUSE_RECHECK_MS,
  PAUSE_SYNC_RETRIES,
  StorePauseCard,
} from "./store-pause";

const MINUTE = 60_000;
const NOW = new Date("2026-10-25T22:00:00Z");
const TIMEZONE = "America/Manaus";
const open: StorePause = {
  paused: false,
  pausedUntil: null,
  timezone: TIMEZONE,
};
const pausedFor = (minutes: number): StorePause => ({
  paused: true,
  pausedUntil: new Date(Date.now() + minutes * MINUTE).toISOString(),
  timezone: TIMEZONE,
});
const indefinite: StorePause = {
  paused: true,
  pausedUntil: null,
  timezone: TIMEZONE,
};

/** Node reads `TZ` again when it changes: the "browser" runs in Tokyo, the store in Manaus. */
const env = (globalThis as { process?: { env: Record<string, string> } })
  .process?.env;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("StorePauseCard", () => {
  const store = { pause: vi.fn(), startPause: vi.fn(), endPause: vi.fn() };
  const activeStore = signal<{ tenantId: string } | null>({ tenantId: "t1" });
  let fixture: ComponentFixture<StorePauseCard>;
  let element: HTMLElement;
  let browserZone: string | undefined;

  const flush = async () => {
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
  };
  const click = async (text: string) => {
    Array.from(element.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === text)!
      .click();
    await flush();
  };
  const status = () => element.querySelector("[role=status]")?.textContent;
  const mount = async () => {
    fixture = TestBed.createComponent(StorePauseCard);
    element = fixture.nativeElement as HTMLElement;
    await flush();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    browserZone = env?.["TZ"];
    if (env) env["TZ"] = "Asia/Tokyo";
    for (const mock of Object.values(store)) mock.mockReset();
    store.pause.mockResolvedValue(open);
    activeStore.set({ tenantId: "t1" });
    TestBed.configureTestingModule({
      imports: [StorePauseCard],
      providers: [
        { provide: StoreApi, useValue: store },
        { provide: Session, useValue: { store: activeStore } },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (env) {
      if (browserZone === undefined) delete env["TZ"];
      else env["TZ"] = browserZone;
    }
  });

  it("pauses for a while, until reopening, and reopens", async () => {
    await mount();
    expect(status()).toContain("recebendo pedidos");

    store.startPause.mockResolvedValue(pausedFor(30));
    await click("Pausar 30 min");
    expect(store.startPause).toHaveBeenCalledWith(30);
    expect(status()).toContain("Pedidos pausados até");

    store.startPause.mockResolvedValue(indefinite);
    await click("Pausar até reabrir");
    expect(store.startPause).toHaveBeenLastCalledWith(null);
    expect(status()).toContain("Pedidos pausados até alguém reabrir.");

    store.endPause.mockResolvedValue(undefined);
    await click("Reabrir agora");
    expect(store.endPause).toHaveBeenCalled();
    expect(status()).toContain("recebendo pedidos");
  });

  it("shows the end time on the store's clock, not the browser's", async () => {
    // 22:30 UTC is 18:30 in Manaus and 07:30 in Tokyo.
    if (env)
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
        "Asia/Tokyo",
      );
    store.pause.mockResolvedValue({
      ...pausedFor(30),
      pausedUntil: "2026-10-25T22:30:00.000Z",
    });
    await mount();
    expect(status()).toContain("Pedidos pausados até 18:30.");

    store.pause.mockResolvedValue({
      ...pausedFor(30),
      pausedUntil: "2026-10-25T22:30:00.000Z",
      timezone: "Not/AZone",
    });
    activeStore.set({ tenantId: "t2" });
    await flush();
    expect(status()).toContain("Pedidos pausados até 22:30 UTC.");
  });

  it("reopens on screen when a 15-minute pause ends, then confirms with the API", async () => {
    await mount();
    store.startPause.mockResolvedValue(pausedFor(15));
    await click("Pausar 15 min");
    expect(status()).toContain("Pedidos pausados até");

    await advance(15 * MINUTE - 1);
    expect(status()).toContain("Pedidos pausados até");
    expect(store.pause).toHaveBeenCalledTimes(1);

    const check = deferred<StorePause>();
    store.pause.mockReturnValueOnce(check.promise);
    await advance(1 + PAUSE_EXPIRY_MARGIN_MS);
    expect(status()).toContain("recebendo pedidos");
    expect(store.pause).toHaveBeenCalledTimes(2);

    // Someone paused again meanwhile: the API's answer wins.
    check.resolve(pausedFor(30));
    await flush();
    expect(status()).toContain("Pedidos pausados até");
  });

  it("keeps a pause until reopening with no timer", async () => {
    store.pause.mockResolvedValue(indefinite);
    await mount();
    expect(status()).toContain("até alguém reabrir");
    expect(vi.getTimerCount()).toBe(0);
    await advance(3 * 60 * MINUTE);
    expect(store.pause).toHaveBeenCalledTimes(1);
    expect(status()).toContain("até alguém reabrir");
  });

  it("drops the timer when reopened before the end", async () => {
    store.pause.mockResolvedValue(pausedFor(15));
    await mount();
    expect(vi.getTimerCount()).toBe(1);
    store.endPause.mockResolvedValue(undefined);
    await click("Reabrir agora");
    expect(vi.getTimerCount()).toBe(0);
    await advance(20 * MINUTE);
    expect(store.pause).toHaveBeenCalledTimes(1);
    expect(status()).toContain("recebendo pedidos");
  });

  it("follows the newest pause when one replaces another", async () => {
    await mount();
    store.startPause.mockResolvedValueOnce(pausedFor(15));
    await click("Pausar 15 min");
    store.startPause.mockResolvedValueOnce(pausedFor(60));
    await click("Pausar 60 min");
    expect(vi.getTimerCount()).toBe(1);

    await advance(30 * MINUTE);
    expect(store.pause).toHaveBeenCalledTimes(1);
    expect(status()).toContain("Pedidos pausados até");

    await advance(30 * MINUTE + PAUSE_EXPIRY_MARGIN_MS);
    expect(store.pause).toHaveBeenCalledTimes(2);
    expect(status()).toContain("recebendo pedidos");
  });

  it("cancels the timer and late answers when destroyed", async () => {
    store.pause.mockResolvedValue(pausedFor(15));
    await mount();
    expect(vi.getTimerCount()).toBe(1);
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(store.pause).toHaveBeenCalledTimes(1);
  });

  it("retries a failed check quietly, then reports it", async () => {
    store.pause.mockResolvedValue(pausedFor(15));
    await mount();
    store.pause.mockRejectedValueOnce(new Error("offline"));
    await advance(15 * MINUTE + PAUSE_EXPIRY_MARGIN_MS);
    expect(status()).toContain("recebendo pedidos");
    expect(element.querySelector("[role=alert]")).toBeNull();

    store.pause.mockResolvedValueOnce(open);
    await advance(PAUSE_RECHECK_MS);
    expect(store.pause).toHaveBeenCalledTimes(3);
    expect(status()).toContain("recebendo pedidos");
    expect(element.querySelector("[role=alert]")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    // A check that keeps failing stops after a few tries and says so.
    store.pause.mockResolvedValueOnce(pausedFor(15));
    activeStore.set({ tenantId: "t2" });
    await flush();
    store.pause.mockRejectedValue(new Error("offline"));
    await advance(15 * MINUTE + PAUSE_EXPIRY_MARGIN_MS);
    await advance(PAUSE_SYNC_RETRIES * PAUSE_RECHECK_MS);
    expect(store.pause).toHaveBeenCalledTimes(4 + 1 + PAUSE_SYNC_RETRIES);
    expect(element.querySelector("[role=alert]")).not.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks again later, not in a loop, when the API's clock is behind", async () => {
    store.pause.mockResolvedValue(pausedFor(15));
    await mount();
    // The API still sees the pause running after the browser saw it end.
    store.pause.mockResolvedValueOnce({
      ...pausedFor(0),
      pausedUntil: new Date(Date.now() + 15 * MINUTE - 1).toISOString(),
    });
    await advance(15 * MINUTE + PAUSE_EXPIRY_MARGIN_MS);
    expect(store.pause).toHaveBeenCalledTimes(2);
    await advance(PAUSE_RECHECK_MS - 1);
    expect(store.pause).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(store.pause).toHaveBeenCalledTimes(3);
  });

  it("loads the new store on a switch and ignores the old store's late answer", async () => {
    const first = deferred<StorePause>();
    store.pause.mockReturnValueOnce(first.promise);
    await mount();
    expect(status()).toContain("Carregando");

    store.pause.mockResolvedValueOnce(open);
    activeStore.set({ tenantId: "t2" });
    await flush();
    expect(status()).toContain("recebendo pedidos");

    first.resolve(pausedFor(15));
    await flush();
    expect(status()).toContain("recebendo pedidos");
    expect(vi.getTimerCount()).toBe(0);
  });
});
