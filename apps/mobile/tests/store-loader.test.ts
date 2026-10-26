import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BRAND_COLORS } from "../src/brand/colors.ts";
import {
  type BrandCache,
  type LoadStoreOptions,
  cachedBrand,
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
const MANIFEST = { name: "Forno do Bairro", colors: DEFAULT_BRAND_COLORS };
const profile = (extra: Record<string, unknown> = {}) => ({
  slug: SLUG,
  name: "Forno do Bairro Oficial",
  brand: { version: 3, colors: RED },
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

type Route = { status: number; body?: unknown } | "offline";
/** A fetch double answering the profile and the status routes; records the URLs it got. */
const api = (routes: { profile: Route; status: Route }) => {
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const route = url.endsWith("/status") ? routes.status : routes.profile;
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
      brandVersion: 3,
      brandSource: "api",
      availability: { kind: "open" },
    });
    assert.deepEqual(await cachedBrand(cache, SLUG), {
      name: "Forno do Bairro Oficial",
      colors: RED,
      version: 3,
    });
    assert.deepEqual(storeMessage(view), {
      screen: "store",
      title: "Forno do Bairro Oficial",
      body: "Aberta agora.",
      offlineNotice: null,
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
      brandVersion: 3,
      brandSource: "cache",
      availability: { kind: "offline" },
    });
    assert.equal(
      cache.writes,
      1,
      "an offline start does not rewrite the cache",
    );
    assert.match(storeMessage(view).offlineNotice!, /última versão salva/);
    assert.match(storeMessage(view).body, /Não foi possível confirmar/);

    const firstStart = await loadStore(options(offline.fetch, memoryCache()));
    assert.equal(firstStart.brandSource, "manifest");
    assert.equal(firstStart.name, "Forno do Bairro");
    assert.deepEqual(firstStart.colors, DEFAULT_BRAND_COLORS);
    assert.match(storeMessage(firstStart).offlineNotice!, /Confira a internet/);
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
      assert.equal(cache.writes, 0);
      assert.deepEqual(view.availability, { kind: "open" });
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
        offlineNotice: null,
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
