import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validatePizzaCatalog } from "@whiteoven/contracts";
import {
  formatCents,
  imageUrl,
  loadMenu,
  menuSections,
  parseMenu,
  pizzaCatalog,
} from "../src/menu/menu.ts";
import { IMAGE, apiMenu } from "./menu-fixture.ts";
import { DEFAULT_BRAND_COLORS } from "../src/brand/colors.ts";
import type { StoreView } from "../src/brand/store-loader.ts";
import { menuNotices } from "../src/screens/store-messages.ts";

const SLUG = "pizzaria-bairro";

describe("public menu", () => {
  it("keeps the fields the app uses and turns into a catalog pizza-pricing accepts", () => {
    const menu = parseMenu(apiMenu());
    assert.ok(menu);
    assert.equal(menu.version, 7);
    assert.equal(menu.flavors[0]!.imageId, IMAGE);
    // A blank description is no description.
    assert.equal(menu.flavors[2]!.description, null);
    assert.equal("store" in menu, false);
    const catalog = validatePizzaCatalog(pizzaCatalog(menu));
    assert.equal(catalog.ok, true, JSON.stringify(catalog));
  });

  it("refuses the whole menu when one entry is malformed", () => {
    const broken: [string, (menu: ReturnType<typeof apiMenu>) => void][] = [
      [
        "no version",
        (menu) => void ((menu as { version?: unknown }).version = undefined),
      ],
      [
        "price as text",
        (menu) =>
          void ((menu.flavorPrices[0] as { priceCents: unknown }).priceCents =
            "50"),
      ],
      ["free pizza", (menu) => void (menu.flavorPrices[0]!.priceCents = 0)],
      [
        "image path",
        (menu) =>
          void ((menu.flavors[0] as { imageId: unknown }).imageId =
            "../../admin"),
      ],
      [
        "three flavors",
        (menu) =>
          void ((menu.sizes[0] as { maxFlavors: unknown }).maxFlavors = 3),
      ],
      [
        "unknown strategy",
        (menu) => void (menu.pricingPolicy.halfAndHalfStrategy = "LOWEST"),
      ],
      [
        "too many extras",
        (menu) => void (menu.pricingPolicy.maxExtrasPerHalf = 11),
      ],
      [
        "extras not a list",
        (menu) => void ((menu as { extras: unknown }).extras = {}),
      ],
    ];
    for (const [label, breakIt] of broken) {
      const menu = apiMenu();
      breakIt(menu);
      assert.equal(parseMenu(menu), null, label);
    }
    for (const value of [null, [], "menu", 7])
      assert.equal(parseMenu(value), null);
    // A store without a pricing policy still shows its menu.
    assert.equal(
      parseMenu({ ...apiMenu(), pricingPolicy: null })?.pricingPolicy,
      null,
    );
  });

  it("lists categories in the API's order with the lowest price of each pizza", () => {
    const sections = menuSections(parseMenu(apiMenu())!);
    assert.deepEqual(
      sections.map((section) => section.name),
      ["Pizzas", "Bebidas"],
    );
    assert.deepEqual(sections[0]!.items[0], {
      kind: "PIZZA",
      id: "calabresa",
      name: "Calabresa",
      description: "Calabresa fatiada e cebola",
      imageId: IMAGE,
      fromCents: 3000,
    });
    assert.deepEqual(sections[1]!.items, [
      {
        kind: "PRODUCT",
        id: "suco",
        name: "Suco de laranja",
        imageId: null,
        priceCents: 900,
      },
    ]);
  });

  it("formats reais and builds image addresses for the store's own slug", () => {
    assert.equal(formatCents(4590), "R$ 45,90");
    assert.equal(formatCents(5), "R$ 0,05");
    assert.equal(formatCents(123_456_78), "R$ 123.456,78");
    assert.equal(
      imageUrl("https://api.example.com", SLUG, IMAGE, "thumbnail"),
      `https://api.example.com/v1/public/stores/${SLUG}/images/${IMAGE}/thumbnail`,
    );
  });

  it("loads the menu, telling a store that is not serving from a failure", async () => {
    const answer = (status: number, body: unknown) => {
      const urls: string[] = [];
      const fetch = (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(body), { status });
      }) as typeof globalThis.fetch;
      return {
        urls,
        load: () =>
          loadMenu({
            apiUrl: "https://api.example.com",
            storeSlug: SLUG,
            fetch,
          }),
      };
    };
    const ok = answer(200, apiMenu());
    const loaded = await ok.load();
    assert.equal(loaded.kind, "ok");
    assert.deepEqual(ok.urls, [
      `https://api.example.com/v1/public/stores/${SLUG}/menu`,
    ]);
    for (const status of [403, 404])
      assert.equal((await answer(status, {}).load()).kind, "unavailable");
    assert.equal((await answer(500, {}).load()).kind, "failed");
    assert.equal((await answer(200, { error: "html" }).load()).kind, "failed");
  });

  it("tells above the menu why the store is not taking orders, never claiming it is open", () => {
    const view = (
      availability: StoreView["availability"],
      brandStale = false,
    ): StoreView => ({
      name: "Forno do Bairro",
      colors: DEFAULT_BRAND_COLORS,
      logoImageId: null,
      brandVersion: 1,
      brandSource: "api",
      brandStale,
      availability,
    });
    assert.deepEqual(menuNotices(view({ kind: "open" })), []);
    assert.deepEqual(
      menuNotices(
        view({
          kind: "closed",
          reason: "OUTSIDE_HOURS",
          pausedUntil: null,
          timezone: "America/Sao_Paulo",
        }),
      ),
      ["Loja fechada. Forno do Bairro está fora do horário de funcionamento."],
    );
    const offline = menuNotices(view({ kind: "offline" }));
    assert.equal(
      offline[0],
      "Não foi possível confirmar se a loja está aberta.",
    );
    assert.equal(offline.length, 2);
    assert.deepEqual(menuNotices(view({ kind: "open" }, true)), [
      "Não conseguimos atualizar a aparência da pizzaria agora. Tente atualizar em instantes.",
    ]);
  });
});
