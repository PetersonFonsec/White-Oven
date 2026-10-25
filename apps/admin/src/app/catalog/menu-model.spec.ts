import { catalogFixture } from "./catalog-fixture.testing";
import {
  EMPTY_PREVIEW,
  MAX_CENTS,
  moneyText,
  parseMoney,
  previewCrusts,
  previewFlavors,
  previewSizes,
  reconcilePreview,
} from "./menu-model";

describe("parseMoney", () => {
  it("reads reais with comma or dot into integer cents", () => {
    expect(parseMoney("12", "product")).toEqual({ ok: true, cents: 1200 });
    expect(parseMoney("12,5", "product")).toEqual({ ok: true, cents: 1250 });
    expect(parseMoney(" 12.50 ", "product")).toEqual({ ok: true, cents: 1250 });
    expect(parseMoney("0.01", "flavor")).toEqual({ ok: true, cents: 1 });
    // 0.29 * 100 is 28.999… in floating point; integer parsing keeps it exact.
    expect(parseMoney("0,29", "crust")).toEqual({ ok: true, cents: 29 });
    expect(parseMoney("19,99", "extra")).toEqual({ ok: true, cents: 1999 });
  });

  it("accepts zero for free crusts, extras and products, never for a flavor", () => {
    for (const kind of ["crust", "extra", "product"] as const)
      expect(parseMoney("0", kind)).toEqual({ ok: true, cents: 0 });
    expect(parseMoney("0", "flavor")).toEqual({
      ok: false,
      message: "O preço do sabor deve ser maior que zero.",
    });
    expect(parseMoney("0,00", "flavor").ok).toBe(false);
  });

  it("rejects empty, negative, non-numeric and over-precise values", () => {
    expect(parseMoney("", "product")).toEqual({
      ok: false,
      message: "Informe um valor.",
    });
    expect(parseMoney("   ", "crust").ok).toBe(false);
    expect(parseMoney("-1", "product")).toEqual({
      ok: false,
      message: "O valor não pode ser negativo.",
    });
    expect(parseMoney("-0,50", "extra").ok).toBe(false);
    for (const text of [
      "abc",
      "12,345",
      "1.234,56",
      "1e3",
      "12,",
      ",5",
      "R$ 10",
      "Infinity",
    ])
      expect(parseMoney(text, "product")).toEqual({
        ok: false,
        message: "Use um valor em reais com até 2 casas, como 12,50.",
      });
  });

  it("rejects amounts above what the API stores", () => {
    expect(parseMoney("21474836,47", "product")).toEqual({
      ok: true,
      cents: MAX_CENTS,
    });
    expect(parseMoney("21474836,48", "product")).toEqual({
      ok: false,
      message: "Valor acima do limite permitido.",
    });
    expect(parseMoney("9".repeat(30), "flavor").ok).toBe(false);
  });

  it("formats cents back for the field", () => {
    expect(moneyText(1250)).toBe("12.50");
    expect(moneyText(5)).toBe("0.05");
    expect(moneyText(undefined)).toBe("");
    expect(parseMoney(moneyText(1999), "flavor")).toEqual({
      ok: true,
      cents: 1999,
    });
  });
});

describe("price preview options", () => {
  it("offers only sizes a customer could order", () => {
    expect(previewSizes(catalogFixture()).map((size) => size.id)).toEqual([
      "large",
      "small",
    ]);
  });

  it("offers only orderable flavors priced for the size", () => {
    const data = catalogFixture();
    expect(previewFlavors(data, "large").map((flavor) => flavor.id)).toEqual([
      "calabresa",
      "margherita",
    ]);
    expect(previewFlavors(data, "small").map((flavor) => flavor.id)).toEqual([
      "calabresa",
    ]);
    expect(previewCrusts(data, "large").map((crust) => crust.id)).toEqual([
      "catupiry",
    ]);
    expect(previewCrusts(data, "small")).toEqual([]);
  });

  it("starts on the first orderable size and flavors", () => {
    expect(reconcilePreview(EMPTY_PREVIEW, catalogFixture())).toEqual({
      sizeId: "large",
      mode: "WHOLE",
      left: "calabresa",
      right: "margherita",
      crustId: "",
    });
  });

  it("revalidates flavors, halves and crust when the size changes", () => {
    const data = catalogFixture();
    const halves = {
      sizeId: "large",
      mode: "HALVES" as const,
      left: "margherita",
      right: "calabresa",
      crustId: "catupiry",
    };
    expect(reconcilePreview(halves, data)).toEqual(halves);
    // Broto takes one flavor, Margherita has no Broto price and Catupiry neither.
    expect(reconcilePreview({ ...halves, sizeId: "small" }, data)).toEqual({
      sizeId: "small",
      mode: "WHOLE",
      left: "calabresa",
      right: "calabresa",
      crustId: "",
    });
  });

  it("leaves a size that is no longer orderable", () => {
    const data = catalogFixture();
    const selection = { ...EMPTY_PREVIEW, sizeId: "giant", left: "calabresa" };
    expect(reconcilePreview(selection, data).sizeId).toBe("large");
    data.sizes = data.sizes.map((size) => ({ ...size, available: false }));
    expect(reconcilePreview(selection, data)).toEqual(EMPTY_PREVIEW);
  });

  it("has no flavor when none is priced for the size", () => {
    const data = catalogFixture();
    data.flavorPrices = [];
    expect(reconcilePreview(EMPTY_PREVIEW, data)).toMatchObject({
      sizeId: "large",
      left: "",
      right: "",
    });
  });
});
