import { catalogFixture } from "../catalog/catalog-fixture.testing";
import {
  crossesMidnight,
  hoursErrorsByEntry,
  policyExamples,
} from "./settings-model";

describe("settings model", () => {
  it("tells which shifts close on the next day", () => {
    expect(crossesMidnight({ opensAt: "18:00", closesAt: "02:00" })).toBe(true);
    expect(crossesMidnight({ opensAt: "11:00", closesAt: "15:00" })).toBe(
      false,
    );
    expect(crossesMidnight({ opensAt: "18:00", closesAt: "" })).toBe(false);
  });

  it("puts API errors on the row the panel shows", () => {
    expect(
      hoursErrorsByEntry([
        { code: "OPENING_HOURS_OVERLAP", path: "rules[2]" },
        { code: "OPENING_HOURS_INVALID", path: "rules[0].closesAt" },
        { code: "OPENING_HOURS_OVERLAP", path: "exceptions[1].shifts[0]" },
        { code: "OPENING_HOURS_DUPLICATE_DATE", path: "exceptions[3].date" },
        { code: "OPENING_HOURS_INVALID", path: "" },
      ]),
    ).toEqual({
      "rules[2]": expect.stringContaining("sobrepõe"),
      "rules[0]": expect.stringContaining("Horário inválido"),
      "exceptions[1].shifts[0]": expect.stringContaining("sobrepõe"),
      "exceptions[3]": "Já existe uma exceção para esta data.",
      hours: expect.stringContaining("Horário inválido"),
    });
  });

  it("prices examples with the policy as chosen, through the pricing engine", () => {
    const data = catalogFixture();
    const highest = policyExamples(data, {
      halfAndHalfStrategy: "HIGHEST",
      halfAndHalfSurchargeCents: 0,
      maxExtrasPerHalf: 4,
    });
    expect(highest).toEqual([
      {
        label: "Grande inteira",
        description: "Margherita",
        unitPriceCents: 6000,
      },
      {
        label: "Grande meio a meio",
        description: "Calabresa + Margherita",
        unitPriceCents: 6000,
      },
    ]);
    const average = policyExamples(data, {
      halfAndHalfStrategy: "AVERAGE",
      halfAndHalfSurchargeCents: 350,
      maxExtrasPerHalf: 4,
    });
    expect(average?.map((example) => example.unitPriceCents)).toEqual([
      6000, 5850,
    ]);
  });

  it("has no examples without two priced flavors on a two-flavor size", () => {
    const data = catalogFixture();
    data.flavorPrices = data.flavorPrices.filter(
      (price) => price.flavorId !== "margherita",
    );
    expect(
      policyExamples(data, {
        halfAndHalfStrategy: "HIGHEST",
        halfAndHalfSurchargeCents: 0,
        maxExtrasPerHalf: 4,
      }),
    ).toBeNull();
  });
});
