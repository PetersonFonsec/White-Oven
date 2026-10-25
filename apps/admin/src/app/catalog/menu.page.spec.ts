import { HttpErrorResponse } from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { CatalogApi, type CatalogSnapshot } from "./catalog-api";
import { catalogFixture } from "./catalog-fixture.testing";
import { MenuPage } from "./menu.page";

const settle = () => new Promise((resolve) => setTimeout(resolve));
const apiError = (status: number, code: string) =>
  new HttpErrorResponse({ status, error: { code, message: "x" } });

describe("MenuPage", () => {
  let catalog: CatalogSnapshot;
  const api = {
    snapshot: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    availability: vi.fn(),
    setFlavorPrice: vi.fn(),
    removeFlavorPrice: vi.fn(),
    setCrustPrice: vi.fn(),
    removeCrustPrice: vi.fn(),
    setExtraPrice: vi.fn(),
    removeExtraPrice: vi.fn(),
    uploadImage: vi.fn(),
    readImage: vi.fn(),
  };

  beforeEach(() => {
    catalog = catalogFixture();
    for (const mock of Object.values(api)) mock.mockReset();
    api.snapshot.mockImplementation(async () => structuredClone(catalog));
    api.update.mockResolvedValue({ id: "x" });
    api.setFlavorPrice.mockResolvedValue(undefined);
    URL.createObjectURL = vi.fn(() => "blob:menu-test");
    URL.revokeObjectURL = vi.fn();
    TestBed.configureTestingModule({
      imports: [MenuPage],
      providers: [{ provide: CatalogApi, useValue: api }],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const render = async () => {
    const fixture = TestBed.createComponent(MenuPage);
    const element = fixture.nativeElement as HTMLElement;
    const flush = async () => {
      await settle();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await flush();
    const query = <T extends Element = HTMLElement>(selector: string) =>
      element.querySelector<T & Element>(selector);
    const button = (text: string, root: ParentNode = element) =>
      Array.from(root.querySelectorAll("button")).find(
        (item) => item.textContent?.trim() === text,
      )!;
    const tab = async (label: string) => {
      button(label).click();
      await flush();
    };
    const type = async (selector: string, value: string) => {
      const input = query<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event("input"));
      await flush();
    };
    const submit = async (selector: string) => {
      query(selector)!.closest("form")!.dispatchEvent(new Event("submit"));
      await flush();
    };
    const choose = async (selector: string, value: string) => {
      const select = query<HTMLSelectElement>(selector)!;
      select.value = value;
      select.dispatchEvent(new Event("change"));
      await flush();
    };
    const upload = async (selector: string, type = "image/png") => {
      const input = query<HTMLInputElement>(selector)!;
      const file = new File([new Uint8Array([1, 2, 3])], "foto.png", { type });
      Object.defineProperty(input, "files", {
        value: [file],
        configurable: true,
      });
      input.dispatchEvent(new Event("change"));
      await flush();
    };
    const alert = () => query('[role="alert"]')?.textContent?.trim() ?? "";
    const notice = () => query(".menu-notice")?.textContent?.trim() ?? "";
    return {
      fixture,
      element,
      flush,
      query,
      button,
      tab,
      type,
      submit,
      choose,
      upload,
      alert,
      notice,
    };
  };

  describe("image upload", () => {
    const fileInput = 'input[aria-label="Imagem de Calabresa"]';

    it("announces success only after the upload and the link both worked", async () => {
      api.uploadImage.mockResolvedValue({ id: "img-1" });
      const page = await render();
      await page.tab("Sabores");
      await page.upload(fileInput);
      expect(api.uploadImage).toHaveBeenCalledTimes(1);
      expect(api.update).toHaveBeenCalledWith("flavors", "calabresa", {
        imageId: "img-1",
      });
      expect(page.notice()).toBe("Imagem enviada e associada ao item.");
      expect(page.alert()).toBe("");
      expect(page.button("Tentar associar de novo")).toBeUndefined();
    });

    it("shows the API's message when the upload fails, and links nothing", async () => {
      api.uploadImage.mockRejectedValue(apiError(0, "NETWORK"));
      const page = await render();
      await page.tab("Sabores");
      await page.upload(fileInput);
      expect(page.alert()).toBe(
        "Não foi possível falar com o servidor. Verifique a conexão.",
      );
      expect(api.update).not.toHaveBeenCalled();
      expect(page.notice()).toBe("");
      expect(page.button("Tentar associar de novo")).toBeUndefined();
    });

    it("refuses other file types before uploading", async () => {
      const page = await render();
      await page.tab("Sabores");
      await page.upload(fileInput, "image/gif");
      expect(page.alert()).toBe(
        "Escolha uma imagem PNG, JPEG ou WebP de até 5 MiB.",
      );
      expect(api.uploadImage).not.toHaveBeenCalled();
    });

    it("keeps the uploaded image when the link fails and retries only the link", async () => {
      api.uploadImage.mockResolvedValue({ id: "img-1" });
      api.update.mockRejectedValueOnce(apiError(409, "RESOURCE_CONFLICT"));
      const page = await render();
      await page.tab("Sabores");
      await page.upload(fileInput);

      expect(page.alert()).toBe(
        "A imagem foi enviada, mas não foi associada ao item: Já existe um cadastro com esses dados. Use “Tentar associar de novo”.",
      );
      expect(page.notice()).toBe("");
      expect(page.element.textContent).toContain(
        "A imagem foi enviada, mas ainda não está associada a “Calabresa”.",
      );

      page.button("Tentar associar de novo").click();
      await page.flush();
      expect(api.uploadImage).toHaveBeenCalledTimes(1);
      expect(api.update).toHaveBeenCalledTimes(2);
      expect(api.update).toHaveBeenLastCalledWith("flavors", "calabresa", {
        imageId: "img-1",
      });
      expect(page.notice()).toBe("Imagem enviada e associada ao item.");
      expect(page.alert()).toBe("");
      expect(page.button("Tentar associar de novo")).toBeUndefined();
    });

    it("can drop a pending image without touching the item", async () => {
      api.uploadImage.mockResolvedValue({ id: "img-1" });
      api.update.mockRejectedValueOnce(apiError(409, "RESOURCE_CONFLICT"));
      const page = await render();
      await page.tab("Sabores");
      await page.upload(fileInput);
      page.button("Descartar").click();
      await page.flush();
      expect(page.button("Tentar associar de novo")).toBeUndefined();
      expect(page.notice()).toContain("Envio descartado.");
      expect(api.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("unsaved edits", () => {
    it("keeps a draft of one item when another item is saved and reloaded", async () => {
      const page = await render();
      await page.tab("Sabores");
      await page.type("#flavor-name-calabresa", "Calabresa especial");
      expect(page.element.textContent).toContain("Não salvo");

      catalog.flavors[1]!.name = "Margherita da casa";
      await page.type("#flavor-name-margherita", "Margherita da casa");
      await page.submit("#flavor-name-margherita");

      expect(api.update).toHaveBeenCalledWith(
        "flavors",
        "margherita",
        expect.objectContaining({ name: "Margherita da casa" }),
      );
      expect(api.snapshot).toHaveBeenCalledTimes(2);
      expect(
        page.query<HTMLInputElement>("#flavor-name-calabresa")!.value,
      ).toBe("Calabresa especial");
      expect(
        page.query<HTMLInputElement>("#flavor-name-margherita")!.value,
      ).toBe("Margherita da casa");
      expect(page.notice()).toBe("Sabor atualizado.");
    });

    it("keeps what was typed when the save fails", async () => {
      api.update.mockRejectedValue(apiError(409, "RESOURCE_CONFLICT"));
      const page = await render();
      await page.tab("Sabores");
      await page.type("#flavor-name-calabresa", "Margherita");
      await page.submit("#flavor-name-calabresa");
      expect(page.alert()).toBe("Já existe um cadastro com esses dados.");
      expect(
        page.query<HTMLInputElement>("#flavor-name-calabresa")!.value,
      ).toBe("Margherita");
      expect(page.element.textContent).toContain("Não salvo");
    });

    it("keeps typed prices when the save fails", async () => {
      api.setFlavorPrice.mockRejectedValue(apiError(0, "NETWORK"));
      const page = await render();
      await page.tab("Sabores");
      await page.type("#flavor\\:calabresa\\:large", "55,90");
      await page.submit("#flavor\\:calabresa\\:large");
      expect(api.setFlavorPrice).toHaveBeenCalledWith(
        "calabresa",
        "large",
        5590,
      );
      expect(
        page.query<HTMLInputElement>("#flavor\\:calabresa\\:large")!.value,
      ).toBe("55,90");
    });

    it("keeps drafts on a manual refresh, says so, and discards only on request", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      const page = await render();
      await page.tab("Sabores");
      await page.type("#flavor-name-calabresa", "Calabresa especial");
      await page.type("#flavor\\:margherita\\:large", "61");

      page.button("Atualizar").click();
      await page.flush();
      expect(page.notice()).toContain("2 alterações não salvas foram mantidas");
      expect(
        page.query<HTMLInputElement>("#flavor-name-calabresa")!.value,
      ).toBe("Calabresa especial");

      page.button("Descartar alterações").click();
      await page.flush();
      expect(confirm).toHaveBeenCalled();
      expect(
        page.query<HTMLInputElement>("#flavor-name-calabresa")!.value,
      ).toBe("Calabresa");
      expect(
        page.query<HTMLInputElement>("#flavor\\:margherita\\:large")!.value,
      ).toBe("60.00");
      expect(page.button("Descartar alterações")).toBeUndefined();
    });

    it("follows the server for items without unsaved changes", async () => {
      const page = await render();
      await page.tab("Sabores");
      catalog.flavors[0]!.name = "Calabresa acebolada";
      page.button("Atualizar").click();
      await page.flush();
      expect(
        page.query<HTMLInputElement>("#flavor-name-calabresa")!.value,
      ).toBe("Calabresa acebolada");
      expect(page.notice()).toBe("");
    });
  });

  describe("money fields", () => {
    const field = "#flavor\\:calabresa\\:large";

    it.each([
      ["", "Informe um valor."],
      ["-5", "O valor não pode ser negativo."],
      ["abc", "Use um valor em reais com até 2 casas, como 12,50."],
      ["12,345", "Use um valor em reais com até 2 casas, como 12,50."],
      ["0", "O preço do sabor deve ser maior que zero."],
    ])(
      "does not send %j and explains it next to the field",
      async (text, message) => {
        const page = await render();
        await page.tab("Sabores");
        await page.type(field, text);
        await page.submit(field);
        expect(api.setFlavorPrice).not.toHaveBeenCalled();
        const input = page.query<HTMLInputElement>(field)!;
        expect(input.getAttribute("aria-invalid")).toBe("true");
        const error = page.query(`#${input.id.replaceAll(":", "\\:")}-error`);
        expect(input.getAttribute("aria-describedby")).toBe(
          `${input.id}-error`,
        );
        expect(error?.textContent?.trim()).toBe(message);
        expect(page.alert()).toBe(
          "Corrija os valores destacados antes de salvar.",
        );
      },
    );

    it("sends cents for decimals and clears the error once fixed", async () => {
      const page = await render();
      await page.tab("Sabores");
      await page.type(field, "-1");
      await page.submit(field);
      await page.type(field, "49,9");
      expect(page.query(field)!.getAttribute("aria-invalid")).toBe("false");
      await page.submit(field);
      expect(api.setFlavorPrice).toHaveBeenCalledWith(
        "calabresa",
        "large",
        4990,
      );
      expect(page.notice()).toBe("Preço atualizado.");
    });

    it("accepts a free crust but not a negative product", async () => {
      api.setCrustPrice.mockResolvedValue(undefined);
      const page = await render();
      await page.tab("Bordas");
      await page.type("#crust\\:catupiry\\:large", "0");
      await page.submit("#crust\\:catupiry\\:large");
      expect(api.setCrustPrice).toHaveBeenCalledWith("catupiry", "large", 0);

      await page.tab("Produtos");
      await page.type("#product\\:soda\\:price", "-8");
      await page.submit("#product\\:soda\\:price");
      expect(api.update).not.toHaveBeenCalled();
      expect(page.element.textContent).toContain(
        "O valor não pode ser negativo.",
      );
    });

    it("sends one request when a save is submitted twice", async () => {
      let finish!: () => void;
      api.setFlavorPrice.mockReturnValue(
        new Promise<void>((resolve) => (finish = resolve)),
      );
      const page = await render();
      await page.tab("Sabores");
      await page.type(field, "52");
      const form = page.query(field)!.closest("form")!;
      form.dispatchEvent(new Event("submit"));
      form.dispatchEvent(new Event("submit"));
      await page.flush();
      expect(api.setFlavorPrice).toHaveBeenCalledTimes(1);
      finish();
      await page.flush();
      expect(page.notice()).toBe("Preço atualizado.");
    });
  });

  describe("price preview", () => {
    const options = (page: Awaited<ReturnType<typeof render>>, name: string) =>
      Array.from(
        page.query<HTMLSelectElement>(`select[name="${name}"]`)!.options,
      ).map((option) => option.textContent?.trim());
    const price = (page: Awaited<ReturnType<typeof render>>) =>
      page.query(".preview-result strong")?.textContent?.replace(/\s/g, "");

    it("prices a whole pizza with only orderable, priced choices", async () => {
      const page = await render();
      await page.tab("Prévia de preço");
      expect(options(page, "previewSize")).toEqual(["Grande", "Broto"]);
      expect(options(page, "previewFlavorLeft")).toEqual([
        "Calabresa",
        "Margherita",
      ]);
      expect(options(page, "previewCrust")).toEqual(["Sem borda", "Catupiry"]);
      expect(price(page)).toContain("50.00");
      expect(page.element.textContent).toContain("HIGHEST sem sobretaxa");
    });

    it("prices halves with the temporary HIGHEST policy", async () => {
      const page = await render();
      await page.tab("Prévia de preço");
      await page.choose('select[name="previewMode"]', "HALVES");
      expect(options(page, "previewFlavorRight")).toEqual([
        "Calabresa",
        "Margherita",
      ]);
      expect(price(page)).toContain("60.00");
      await page.choose('select[name="previewCrust"]', "catupiry");
      expect(price(page)).toContain("70.00");
    });

    it("revalidates choices when the size changes", async () => {
      const page = await render();
      await page.tab("Prévia de preço");
      await page.choose('select[name="previewMode"]', "HALVES");
      await page.choose('select[name="previewCrust"]', "catupiry");
      await page.choose('select[name="previewSize"]', "small");
      expect(options(page, "previewMode")).toEqual(["Inteira"]);
      expect(options(page, "previewFlavorLeft")).toEqual(["Calabresa"]);
      expect(options(page, "previewCrust")).toEqual(["Sem borda"]);
      expect(page.query('select[name="previewFlavorRight"]')).toBeNull();
      expect(price(page)).toContain("30.00");
    });

    it("explains when no flavor has a price for the size", async () => {
      catalog.flavorPrices = catalog.flavorPrices.filter(
        (item) => item.sizeId !== "small",
      );
      const page = await render();
      await page.tab("Prévia de preço");
      await page.choose('select[name="previewSize"]', "small");
      expect(page.element.textContent).toContain(
        "Nenhum sabor disponível tem preço para este tamanho.",
      );
      expect(page.query(".preview-result")).toBeNull();
    });

    it("explains when no size is orderable", async () => {
      catalog.sizes = catalog.sizes.map((size) => ({
        ...size,
        available: false,
      }));
      const page = await render();
      await page.tab("Prévia de preço");
      expect(page.element.textContent).toContain("Nenhum tamanho disponível.");
      expect(page.query('select[name="previewSize"]')).toBeNull();
    });
  });
});
