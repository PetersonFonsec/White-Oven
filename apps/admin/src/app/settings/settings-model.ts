import type { PricingPolicy } from "@whiteoven/contracts";
import { evaluatePizza } from "@whiteoven/pizza-pricing";
import type { CatalogSnapshot } from "../catalog/catalog-api";
import {
  previewFlavors,
  previewSizes,
  pricingCatalog,
} from "../catalog/menu-model";
import type { TimeRange } from "./store-api";

export const WEEKDAYS = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
] as const;

/** Monday first, as Brazilian stores read their week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const minutes = (time: string) => {
  const [hours, mins] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
};

/** A range that closes at or before it opens ends on the next day (18:00–02:00). */
export const crossesMidnight = (range: TimeRange) =>
  range.closesAt !== "" &&
  range.opensAt !== "" &&
  minutes(range.closesAt) < minutes(range.opensAt);

const HOURS_MESSAGES: Record<string, string> = {
  OPENING_HOURS_OVERLAP:
    "Este horário se sobrepõe a outro turno, contando a madrugada do dia anterior ou o dia seguinte.",
  OPENING_HOURS_DUPLICATE_DATE: "Já existe uma exceção para esta data.",
  OPENING_HOURS_INVALID:
    "Horário inválido. Abertura e fechamento precisam ser diferentes.",
};

export const hoursErrorMessage = (code: string) =>
  HOURS_MESSAGES[code] ?? "Confira este horário.";

/**
 * Groups API error paths by the entry the panel shows: `rules[2].closesAt` belongs to the row
 * `rules[2]`, `exceptions[0].shifts[1]` to that substitute shift and `exceptions[0].date` to the
 * exception itself.
 */
export function hoursErrorsByEntry(
  errors: { code: string; path: string }[],
): Record<string, string> {
  const byEntry: Record<string, string> = {};
  for (const { code, path } of errors) {
    const entry =
      /^(rules\[\d+\]|exceptions\[\d+\]\.shifts\[\d+\]|exceptions\[\d+\])/.exec(
        path,
      )?.[1] ?? "hours";
    byEntry[entry] ??= hoursErrorMessage(code);
  }
  return byEntry;
}

export interface PolicyExample {
  label: string;
  description: string;
  unitPriceCents: number | null;
}

/**
 * Price examples for a pricing policy, computed by `evaluatePizza` on the store's own catalog: a
 * whole pizza and a half-and-half of the cheapest and the most expensive flavor of the first size
 * that takes two flavors. Null when the catalog has no such size with two priced flavors.
 */
export function policyExamples(
  data: CatalogSnapshot,
  policy: PricingPolicy,
): PolicyExample[] | null {
  const size = previewSizes(data).find((item) => item.maxFlavors === 2);
  if (!size) return null;
  const priceOf = (flavorId: string) =>
    data.flavorPrices.find(
      (price) => price.flavorId === flavorId && price.sizeId === size.id,
    )!.priceCents;
  const flavors = previewFlavors(data, size.id).sort(
    (a, b) => priceOf(a.id) - priceOf(b.id),
  );
  if (flavors.length < 2) return null;
  const cheap = flavors[0]!;
  const expensive = flavors[flavors.length - 1]!;
  const evaluate = (mode: "WHOLE" | "HALVES") => {
    const result = evaluatePizza(
      {
        sizeId: size.id,
        mode,
        flavors:
          mode === "HALVES"
            ? { LEFT: cheap.id, RIGHT: expensive.id }
            : { LEFT: expensive.id },
        crustId: null,
        extras: [],
        removals: [],
        quantity: 1,
      },
      pricingCatalog(data),
      policy,
    );
    return result.ok ? result.price.unitPriceCents : null;
  };
  return [
    {
      label: `${size.name} inteira`,
      description: expensive.name,
      unitPriceCents: evaluate("WHOLE"),
    },
    {
      label: `${size.name} meio a meio`,
      description: `${cheap.name} + ${expensive.name}`,
      unitPriceCents: evaluate("HALVES"),
    },
  ];
}
