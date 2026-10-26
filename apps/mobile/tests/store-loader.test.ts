import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BRAND_COLORS } from "../src/brand/colors.ts";
import {
  type BrandCache,
  type LoadStoreOptions,
  cachedBrand,
  createStoreRefresher,
  loadStore,
} from "../src/brand/store-loader.ts";
import { storeMessage } from "../src/screens/store-messages.ts";

const SLUG = "pizzaria-bairro";
const RED = {
  primary: "#B3261E",
  primaryHover: "#8C1D18",
  primaryPressed: "#601410",
  onPrimary: "#FFFFFF",
  accentText: "#8C1D18",
};
const LOGO = "7d7c3c39-3a54-4c8e-9a44-5a0d2f3f8f11";
const MANIFEST = { name: "Forno do Bairro", colors: DEFAULT_BRAND_COLORS };
const profile = (extra: Record<string, unknown> = {}) => ({
  slug: SLUG,
  name: "Forno do Bairro Oficial",
  brand: { version: 3, colors: RED, logoImageId: LOGO },
  ...extra,
});
const OPEN = {
  open: true,
  reason: "OPEN",
  pausedUntil: null,
  timezone: "America/Sao_Paulo",
  checkedAt: "2026-10-26T15:00:00.000Z",
};

const memoryCache = (initial: string | null = null) => {
  const cache = {
    value: initial,
    writes: 0,
    failWrites: false,
    async read() {
      return cache.value;
    },
    async write(value: string) {
      if (cache.failWrites) throw new Error("disk full");
      cache.writes += 1;
      cache.value = value;
    },
  };
  return cache satisfies BrandCache;
};

type Route = { status: number; body?: unknown } | "offline" | "hang";
/** A fetch double answering the profile and the status routes; records the URLs it got. */
const api = (
  routes: { profile: Route; status: Route },
  /** Holds every answer until it resolves, to interleave loads in a test. */
  gate: Promise<void> = Promise.resolve(),
) => {
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const route = url.endsWith("/status") ? routes.status : routes.profile;
    if (route === "hang")
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    await gate;
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (route === "offline") throw new TypeError("Network request failed");
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, urls };
};
const options = (
  fetch: typeof globalThis.fetch,
  cache: BrandCache,
): LoadStoreOptions => ({
  apiUrl: "https://api.example.com",
  storeSlug: SLUG,
  fallback: MANIFEST,
  cache,
  fetch,
});

describe("store brand and status", () => {
  it("wears the brand from the API, keeps it for later and shows the store open", async () => {
    const cache = memoryCache();
    const { fetch, urls } = api({
      profile: { status: 200, body: profile() },
      status: { status: 200, body: OPEN },
    });
    const view = await loadStore(options(fetch, cache));
    assert.deepEqual(urls.sort(), [
      `https://api.example.com/v1/public/stores/${SLUG}`,
      `https://api.example.com/v1/public/stores/${SLUG}/status`,
    ]);
    assert.deepEqual(view, {
      name: "Forno do Bairro Oficial",
      colors: RED,
      logoImageId: LOGO,
      brandVersion: 3,
      brandSource: "api",
      brandStale: false,
      availability: { kind: "open" },
    });
    assert.deepEqual(await cachedBrand(cache, SLUG), {
      name: "Forno do Bairro Oficial",
      colors: RED,
      logoImageId: LOGO,
      version: 3,
    });
    assert.deepEqual(storeMessage(view), {
      screen: "store",
      title: "Forno do Bairro Oficial",
      body: "Aberta agora.",
      notice: null,
    });
  });

  it("opens offline with the last brand, and with the manifest's before any answer", async () => {
    const cache = memoryCache();
    const online = api({
      profile: { status: 200, body: profile() },
      status: { status: 200, body: OPEN },
    });
    await loadStore(options(online.fetch, cache));

    const offline = api({ profile: "offline", status: "offline" });
    const view = await loadStore(options(offline.fetch, cache));
    assert.deepEqual(view, {
      name: "Forno do Bairro Oficial",
      colors: RED,
      logoImageId: LOGO,
      brandVersion: 3,
      brandSource: "cache",
      brandStale: true,
      availability: { kind: "offline" },
    });
    assert.equal(
      cache.writes,
      1,
      "an offline start does not rewrite the cache",
    );
    assert.match(storeMessage(view).notice!, /última versão salva/);
    assert.match(storeMessage(view).body, /Não foi possível confirmar/);

    const firstStart = await loadStore(options(offline.fetch, memoryCache()));
    assert.equal(firstStart.brandSource, "manifest");
    assert.equal(firstStart.name, "Forno do Bairro");
    assert.deepEqual(firstStart.colors, DEFAULT_BRAND_COLORS);
    assert.match(storeMessage(firstStart).notice!, /Confira a internet/);
  });

  it("treats server errors and timeouts like being offline", async () => {
    const cache = memoryCache(
      JSON.stringify({ version: 1, profile: profile() }),
    );
    for (const status of [500, 502, 503, 429]) {
      const { fetch } = api({ profile: { status }, status: { status } });
      const view = await loadStore(options(fetch, cache));
      assert.equal(view.brandSource, "cache", String(status));
      assert.deepEqual(view.availability, { kind: "offline" });
    }
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        ),
      )) as typeof globalThis.fetch;
    const view = await loadStore({ ...options(hanging, cache), timeoutMs: 20 });
    assert.equal(view.brandSource, "cache");
    assert.deepEqual(view.availability, { kind: "offline" });
  });

  it("ignores a cache that is broken, old, too big or of another store", async () => {
    const { fetch } = api({ profile: "offline", status: "offline" });
    for (const raw of [
      "{",
      JSON.stringify({ version: 0, profile: profile() }),
      JSON.stringify({ version: 1, profile: profile({ slug: "outra-loja" }) }),
      JSON.stringify({
        version: 1,
        profile: profile({
          brand: { version: 1, colors: { ...RED, onPrimary: "#B3261E" } },
        }),
      }),
      JSON.stringify({
        version: 1,
        profile: profile({ name: "x".repeat(20_000) }),
      }),
    ]) {
      const view = await loadStore(options(fetch, memoryCache(raw)));
      assert.equal(view.brandSource, "manifest", raw.slice(0, 40));
    }
    // A cache written before the logo existed (M5.1) still opens the app, without a logo.
    const beforeLogo = await loadStore(
      options(
        fetch,
        memoryCache(
          JSON.stringify({
            version: 1,
            profile: profile({ brand: { version: 3, colors: RED } }),
          }),
        ),
      ),
    );
    assert.equal(beforeLogo.brandSource, "cache");
    assert.equal(beforeLogo.logoImageId, null);
    const unreadable: BrandCache = {
      read: () => Promise.reject(new Error("io")),
      write: () => Promise.resolve(),
    };
    assert.equal(
      (await loadStore(options(fetch, unreadable))).brandSource,
      "manifest",
    );
  });

  it("never stores or shows a profile of another store or with unreadable colors", async () => {
    for (const body of [
      profile({ slug: "outra-loja" }),
      profile({
        brand: { version: 4, colors: { ...RED, onPrimary: "#B3261E" } },
      }),
      profile({ brand: { version: -1, colors: RED } }),
      profile({ brand: { version: 4, colors: RED, logoImageId: "../admin" } }),
      profile({ name: "" }),
      { error: "html page" },
    ]) {
      const cache = memoryCache();
      const { fetch } = api({
        profile: { status: 200, body },
        status: { status: 200, body: OPEN },
      });
      const view = await loadStore(options(fetch, cache));
      assert.equal(view.brandSource, "manifest");
      assert.equal(view.brandStale, true);
      assert.equal(cache.writes, 0);
      assert.deepEqual(view.availability, { kind: "open" });
      assert.match(storeMessage(view).notice!, /atualizar a aparência/);
    }
  });

  it("shows the closed notice with the pause end in the store's time", async () => {
    const closed = async (status: Record<string, unknown>) =>
      storeMessage(
        await loadStore(
          options(
            api({
              profile: { status: 200, body: profile() },
              status: {
                status: 200,
                body: { ...OPEN, open: false, ...status },
              },
            }).fetch,
            memoryCache(),
          ),
        ),
      );
    assert.deepEqual(
      await closed({
        reason: "PAUSED",
        pausedUntil: "2026-10-26T22:30:00.000Z",
      }),
      {
        screen: "closed",
        title: "Loja fechada",
        body: "Forno do Bairro Oficial pausou os pedidos até 19:30.",
        notice: null,
      },
    );
    assert.match(
      (await closed({ reason: "PAUSED", pausedUntil: null })).body,
      /pausou os pedidos por enquanto/,
    );
    assert.match(
      (await closed({ reason: "OUTSIDE_HOURS" })).body,
      /fora do horário de funcionamento/,
    );
  });

  it("shows the unavailable notice for a store the API does not serve, still with its last brand", async () => {
    const cache = memoryCache(
      JSON.stringify({ version: 1, profile: profile() }),
    );
    for (const status of [403, 404]) {
      const { fetch } = api({
        profile: { status, body: { code: "TENANT_NOT_ACTIVE" } },
        status: { status, body: { code: "TENANT_NOT_ACTIVE" } },
      });
      const view = await loadStore(options(fetch, cache));
      assert.deepEqual(view.availability, { kind: "unavailable" });
      assert.equal(view.brandSource, "cache");
      assert.equal(storeMessage(view).screen, "unavailable");
      assert.equal(storeMessage(view).title, "Pizzaria indisponível");
    }
  });

  it("keeps working when the brand cannot be saved, and never caches the status", async () => {
    const cache = memoryCache();
    cache.failWrites = true;
    const { fetch } = api({
      profile: { status: 200, body: profile() },
      status: "offline",
    });
    const view = await loadStore(options(fetch, cache));
    assert.equal(view.brandSource, "api");
    assert.deepEqual(view.availability, { kind: "offline" });

    cache.failWrites = false;
    await loadStore(
      options(
        api({
          profile: { status: 200, body: profile() },
          status: { status: 200, body: OPEN },
        }).fetch,
        cache,
      ),
    );
    assert.doesNotMatch(cache.value!, /open|reason/);
  });
});

const deferred = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
};
const CLOSED = { ...OPEN, open: false, reason: "OUTSIDE_HOURS" };
const cachedRed = () =>
  memoryCache(JSON.stringify({ version: 1, profile: profile() }));

describe("partial answers: the profile and the status decide separately", () => {
  const load = (
    routes: { profile: Route; status: Route },
    cache: BrandCache = memoryCache(),
  ) => loadStore({ ...options(api(routes).fetch, cache), timeoutMs: 20 });

  it("keeps a valid status when only the profile fails, with a non-blocking notice", async () => {
    const cases: [Route, Route, string][] = [
      [{ status: 500 }, { status: 200, body: OPEN }, "open"],
      [{ status: 429 }, { status: 200, body: OPEN }, "open"],
      ["hang", { status: 200, body: OPEN }, "open"],
      [
        { status: 200, body: { slug: SLUG } },
        { status: 200, body: CLOSED },
        "closed",
      ],
      ["offline", { status: 200, body: CLOSED }, "closed"],
    ];
    for (const [profileRoute, statusRoute, kind] of cases) {
      const label = JSON.stringify([profileRoute, kind]);
      const withCache = await load(
        { profile: profileRoute, status: statusRoute },
        cachedRed(),
      );
      assert.equal(withCache.availability.kind, kind, label);
      assert.equal(withCache.brandSource, "cache", label);
      assert.deepEqual(withCache.colors, RED, label);
      assert.equal(withCache.brandStale, true, label);
      const message = storeMessage(withCache);
      assert.equal(message.screen, kind === "open" ? "store" : "closed");
      assert.equal(
        message.notice,
        "Não conseguimos atualizar a aparência da pizzaria agora. Tente atualizar em instantes.",
        label,
      );
      if (kind === "open") assert.equal(message.body, "Aberta agora.");

      const withoutCache = await load({
        profile: profileRoute,
        status: statusRoute,
      });
      assert.equal(withoutCache.availability.kind, kind, label);
      assert.equal(withoutCache.brandSource, "manifest", label);
      assert.equal(withoutCache.name, "Forno do Bairro");
      assert.equal(withoutCache.brandStale, true, label);
    }
  });

  it("never claims the store is open without a valid status", async () => {
    for (const statusRoute of [
      "hang",
      "offline",
      { status: 500 },
      { status: 200, body: { open: "sim" } },
    ] as Route[]) {
      const cache = memoryCache();
      const view = await load(
        { profile: { status: 200, body: profile() }, status: statusRoute },
        cache,
      );
      const label = JSON.stringify(statusRoute);
      assert.deepEqual(view.availability, { kind: "offline" }, label);
      assert.equal(view.brandSource, "api", label);
      assert.equal(view.brandStale, false, label);
      assert.equal(cache.writes, 1, "the fresh brand is still saved");
      const message = storeMessage(view);
      assert.equal(message.screen, "store");
      assert.notEqual(message.body, "Aberta agora.");
      assert.match(message.body, /Não foi possível confirmar/);
      assert.match(message.notice!, /conexão com a pizzaria falhou/);
    }
    const both = await load(
      { profile: "offline", status: "hang" },
      cachedRed(),
    );
    assert.deepEqual(both.availability, { kind: "offline" });
    assert.equal(both.brandSource, "cache");
    assert.match(storeMessage(both).notice!, /última versão salva/);
  });

  it("shows the store as unavailable on a 403 or 404 from either request", async () => {
    for (const routes of [
      { profile: { status: 403 }, status: { status: 200, body: OPEN } },
      { profile: { status: 200, body: profile() }, status: { status: 404 } },
      { profile: { status: 404 }, status: "offline" },
      { profile: "offline", status: { status: 403 } },
    ] as { profile: Route; status: Route }[]) {
      const view = await load(routes, cachedRed());
      assert.deepEqual(view.availability, { kind: "unavailable" });
      assert.equal(
        view.brandStale,
        false,
        "no brand notice over the unavailable screen",
      );
      assert.deepEqual(storeMessage(view), {
        screen: "unavailable",
        title: "Pizzaria indisponível",
        body: "Forno do Bairro Oficial não está recebendo pedidos por este aplicativo no momento.",
        notice: null,
      });
    }
  });

  it("recovers after a partial failure", async () => {
    const cache = cachedRed();
    const stale = await load(
      { profile: { status: 503 }, status: { status: 200, body: OPEN } },
      cache,
    );
    assert.equal(stale.brandStale, true);
    const blue = {
      ...RED,
      primary: "#0B4F8A",
      primaryHover: "#083D6B",
      primaryPressed: "#062C4E",
    };
    const fresh = await load(
      {
        profile: {
          status: 200,
          body: profile({ brand: { version: 4, colors: blue } }),
        },
        status: { status: 200, body: OPEN },
      },
      cache,
    );
    assert.equal(fresh.brandStale, false);
    assert.equal(fresh.brandSource, "api");
    assert.deepEqual(fresh.colors, blue);
    assert.equal(storeMessage(fresh).notice, null);
    assert.equal((await cachedBrand(cache, SLUG))!.version, 4);
  });
});

describe("refresh: one load at a time, never an old answer over a new one", () => {
  it("joins taps while a load runs: one pair of requests and one answer", async () => {
    const { gate, release } = deferred();
    const { fetch, urls } = api(
      {
        profile: { status: 200, body: profile() },
        status: { status: 200, body: OPEN },
      },
      gate,
    );
    const cache = memoryCache();
    const refresher = createStoreRefresher(options(fetch, cache));
    const first = refresher.refresh();
    const second = refresher.refresh();
    const third = refresher.refresh();
    assert.equal(second, first);
    assert.equal(third, first);
    assert.equal(urls.length, 2);
    assert.equal(refresher.refreshing, true);
    await Promise.resolve();
    assert.equal(
      refresher.refreshing,
      true,
      "still running until the answer arrives",
    );
    release();
    const view = await first;
    assert.equal(view!.brandSource, "api");
    assert.equal(refresher.refreshing, false);
    assert.equal(cache.writes, 1);
  });

  it("lets a later load replace the brand, in order", async () => {
    const cache = memoryCache();
    let version = 1;
    const fetch = (async (input: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/status")
            ? OPEN
            : profile({ brand: { version, colors: RED } }),
        ),
        { status: 200 },
      )) as typeof globalThis.fetch;
    const refresher = createStoreRefresher(options(fetch, cache));
    assert.equal((await refresher.refresh())!.brandVersion, 1);
    version = 2;
    assert.equal((await refresher.refresh())!.brandVersion, 2);
    assert.equal((await cachedBrand(cache, SLUG))!.version, 2);
  });

  it("does not block new attempts after a failure", async () => {
    let online = false;
    const fetch = (async (input: RequestInfo | URL) => {
      if (!online) throw new TypeError("Network request failed");
      return new Response(
        JSON.stringify(String(input).endsWith("/status") ? OPEN : profile()),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    const refresher = createStoreRefresher(options(fetch, memoryCache()));
    const failed = await refresher.refresh();
    assert.deepEqual(failed!.availability, { kind: "offline" });
    assert.equal(refresher.refreshing, false);
    online = true;
    const view = await refresher.refresh();
    assert.deepEqual(view!.availability, { kind: "open" });
    assert.equal(view!.brandSource, "api");
  });

  it("drops a load abandoned on unmount: no answer and nothing written to the cache", async () => {
    const { gate, release } = deferred();
    const { fetch } = api(
      {
        profile: { status: 200, body: profile() },
        status: { status: 200, body: OPEN },
      },
      gate,
    );
    const cache = cachedRed();
    const before = cache.value;
    const refresher = createStoreRefresher(options(fetch, cache));
    const pending = refresher.refresh();
    refresher.dispose();
    release();
    assert.equal(await pending, null);
    assert.equal(cache.writes, 0);
    assert.equal(cache.value, before);
    assert.equal(refresher.refreshing, false);

    const urls = api({ profile: "offline", status: "offline" });
    const afterwards = createStoreRefresher(options(urls.fetch, cache));
    afterwards.dispose();
    assert.equal(await afterwards.refresh(), null);
    assert.equal(urls.urls.length, 0, "a disposed refresher sends nothing");
  });

  it("never writes the cache from an aborted load, even when its answer arrives", async () => {
    const controller = new AbortController();
    const { gate, release } = deferred();
    // A fetch that ignores the abort signal and answers anyway, like a response already in flight.
    const fetch = (async (input: RequestInfo | URL) => {
      await gate;
      return new Response(
        JSON.stringify(String(input).endsWith("/status") ? OPEN : profile()),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    const cache = memoryCache();
    const loading = loadStore({
      ...options(fetch, cache),
      signal: controller.signal,
    });
    controller.abort();
    release();
    assert.equal((await loading).brandSource, "api");
    assert.equal(cache.writes, 0);
  });
});
