import { HttpErrorResponse } from "@angular/common/http";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { CatalogApi } from "../catalog/catalog-api";
import { Session } from "../core/session";
import { BrandPage } from "./brand.page";
import { type BrandState, StoreApi } from "./store-api";

const settle = () => new Promise((resolve) => setTimeout(resolve));
const DEFAULTS = {
  primary: "#FF922B",
  primaryHover: "#E87916",
  primaryPressed: "#E8750C",
  onPrimary: "#252525",
  accentText: "#9C4300",
};
const RED = {
  primary: "#B3261E",
  primaryHover: "#8C1D18",
  primaryPressed: "#601410",
  onPrimary: "#FFFFFF",
};
const state = (overrides: Partial<BrandState> = {}): BrandState => ({
  saved: false,
  theme: {
    colorOverrides: {},
    logoAssetId: null,
    iconAssetId: null,
    version: 0,
  },
  colors: { ...DEFAULTS },
  defaults: { ...DEFAULTS },
  fixedColors: { surface: "#FFFFFF", cream: "#FFF8F0" },
  contrastRules: [
    {
      foreground: "onPrimary",
      background: "primary",
      minimum: 4.5,
      usage: "Texto dos botões principais",
    },
    {
      foreground: "onPrimary",
      background: "primaryHover",
      minimum: 4.5,
      usage: "Botão com cursor",
    },
    {
      foreground: "onPrimary",
      background: "primaryPressed",
      minimum: 4.5,
      usage: "Botão pressionado",
    },
    {
      foreground: "accentText",
      background: "surface",
      minimum: 4.5,
      usage: "Destaque no branco",
    },
    {
      foreground: "accentText",
      background: "cream",
      minimum: 4.5,
      usage: "Destaque no creme",
    },
  ],
  imageRules: { logoMinSide: 256, iconMinSide: 512 },
  ...overrides,
});
const LOGO = "11111111-1111-4111-8111-111111111111";
const ICON = "22222222-2222-4222-8222-222222222222";

describe("BrandPage", () => {
  const store = { brand: vi.fn(), updateBrand: vi.fn() };
  const catalog = { uploadImage: vi.fn(), readImage: vi.fn() };

  beforeEach(() => {
    for (const mock of [...Object.values(store), ...Object.values(catalog)])
      mock.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:brand-test");
    URL.revokeObjectURL = vi.fn();
    TestBed.configureTestingModule({
      imports: [BrandPage],
      providers: [
        { provide: StoreApi, useValue: store },
        { provide: CatalogApi, useValue: catalog },
        {
          provide: Session,
          useValue: { store: signal({ displayName: "Pizzaria Centro" }) },
        },
      ],
    });
  });

  async function render(initial = state()) {
    store.brand.mockResolvedValue(initial);
    const fixture = TestBed.createComponent(BrandPage);
    const element = fixture.nativeElement as HTMLElement;
    const flush = async () => {
      await settle();
      fixture.detectChanges();
      await settle();
      fixture.detectChanges();
    };
    await flush();
    const query = <T extends Element>(selector: string) =>
      element.querySelector<T>(selector);
    const type = async (token: string, value: string) => {
      const input = query<HTMLInputElement>(`#brand-${token}`)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
      await flush();
    };
    const publish = async () => {
      query("form")!.dispatchEvent(new Event("submit"));
      await flush();
    };
    const button = () =>
      Array.from(element.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === "Publicar marca",
      )!;
    const pair = (path: string) =>
      query(`[data-pair="${path}"]`)!.textContent!.replace(/\s+/g, " ");
    const choose = async (slot: string) => {
      const input = query<HTMLInputElement>(`#brand-${slot}-file`)!;
      Object.defineProperty(input, "files", {
        value: [
          new File([new Uint8Array([1])], `${slot}.png`, { type: "image/png" }),
        ],
        configurable: true,
      });
      input.dispatchEvent(new Event("change"));
      await flush();
    };
    return {
      fixture,
      element,
      query,
      type,
      publish,
      button,
      pair,
      choose,
      flush,
    };
  }

  it("previews colors live and publishes only the overridden tokens", async () => {
    const page = await render();
    expect(page.element.textContent).toContain("ainda usa as cores padrão");
    expect(page.pair("contrast.onPrimary/primary")).toContain("atende");
    for (const [token, value] of Object.entries(RED))
      await page.type(token, value);
    const phone = page.query<HTMLElement>(".brand-preview")!;
    expect(phone.style.getPropertyValue("--brand-primary")).toBe("#B3261E");
    expect(page.element.textContent).toContain("Pizzaria Centro");
    expect(page.button().disabled).toBe(false);

    store.updateBrand.mockResolvedValue(
      state({
        saved: true,
        theme: {
          colorOverrides: RED,
          logoAssetId: null,
          iconAssetId: null,
          version: 1,
        },
        colors: { ...DEFAULTS, ...RED },
      }),
    );
    await page.publish();
    expect(store.updateBrand).toHaveBeenCalledWith({
      colorOverrides: RED,
      logoAssetId: null,
      iconAssetId: null,
    });
    expect(page.query("[role=status]")!.textContent).toContain(
      "Marca publicada (versão 1).",
    );
    expect(page.element.textContent).toContain("Versão publicada: 1.");
  });

  it("does not publish while a contrast pair fails, and says which and why", async () => {
    const page = await render();
    await page.type("onPrimary", "#FFFFFF");
    expect(page.pair("contrast.onPrimary/primary")).toMatch(
      /insuficiente.*mínimo 4,50:1/,
    );
    expect(page.query(".contrast--fail")).not.toBeNull();
    expect(page.button().disabled).toBe(true);
    expect(page.query("#publish-blocked")!.textContent).toContain(
      "pares de contraste",
    );
    await page.publish();
    expect(store.updateBrand).not.toHaveBeenCalled();

    // Back to the default, the pair passes again.
    Array.from(page.element.querySelectorAll("button"))
      .filter((item) => item.textContent?.trim() === "Usar padrão")
      .find((item) => !item.disabled)!
      .click();
    await page.flush();
    expect(page.query(".contrast--fail")).toBeNull();
    expect(page.button().disabled).toBe(false);
  });

  it("flags a malformed color and keeps the last valid one in the preview", async () => {
    const page = await render();
    await page.type("primary", "laranja");
    expect(page.query("#brand-primary-error")!.textContent).toContain(
      "#RRGGBB",
    );
    expect(page.query("#brand-primary")!.getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(
      page
        .query<HTMLElement>(".brand-preview")!
        .style.getPropertyValue("--brand-primary"),
    ).toBe("#FF922B");
    expect(page.button().disabled).toBe(true);
    await page.type("primary", "ff922b");
    expect(page.query("#brand-primary-error")).toBeNull();
  });

  it("uploads logo and icon, shows the API's image errors next to them, and removes", async () => {
    const page = await render();
    catalog.uploadImage.mockResolvedValueOnce({
      id: LOGO,
      width: 800,
      height: 300,
    });
    await page.choose("logo");
    catalog.uploadImage.mockResolvedValueOnce({
      id: ICON,
      width: 800,
      height: 300,
    });
    await page.choose("icon");
    expect(catalog.uploadImage).toHaveBeenCalledTimes(2);
    expect(page.query<HTMLImageElement>(".brand-image-preview")!.src).toBe(
      "blob:brand-test",
    );

    store.updateBrand.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 422,
        error: {
          code: "BRAND_THEME_INVALID",
          details: {
            errors: [{ code: "BRAND_ICON_NOT_SQUARE", path: "iconAssetId" }],
          },
        },
      }),
    );
    await page.publish();
    expect(store.updateBrand).toHaveBeenLastCalledWith({
      colorOverrides: {},
      logoAssetId: LOGO,
      iconAssetId: ICON,
    });
    expect(page.query("[role=alert]")!.textContent).toContain(
      "não foi publicada",
    );
    expect(page.query("#brand-icon-error")!.textContent).toContain("quadrado");

    Array.from(page.element.querySelectorAll("button"))
      .find((item) => item.textContent?.trim() === "Remover ícone")!
      .click();
    await page.flush();
    expect(page.query("#brand-icon-error")).toBeNull();
    store.updateBrand.mockResolvedValue(state({ saved: true }));
    await page.publish();
    expect(store.updateBrand).toHaveBeenLastCalledWith({
      colorOverrides: {},
      logoAssetId: LOGO,
      iconAssetId: null,
    });
  });

  it("loads the saved theme and its images", async () => {
    catalog.readImage.mockResolvedValue(new Blob([new Uint8Array([1])]));
    const page = await render(
      state({
        saved: true,
        theme: {
          colorOverrides: RED,
          logoAssetId: LOGO,
          iconAssetId: ICON,
          version: 3,
        },
        colors: { ...DEFAULTS, ...RED },
      }),
    );
    expect(page.query<HTMLInputElement>("#brand-primary")!.value).toBe(
      "#B3261E",
    );
    expect(catalog.readImage).toHaveBeenCalledWith(LOGO, "menu");
    expect(catalog.readImage).toHaveBeenCalledWith(ICON, "menu");
    expect(page.element.querySelectorAll(".brand-image-preview")).toHaveLength(
      2,
    );
    expect(page.element.textContent).toContain("Versão publicada: 3.");
  });
});
