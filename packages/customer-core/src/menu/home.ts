import type { MenuItem, MenuSection } from "./menu.ts";

/**
 * What the home screen picks from the menu: featured pizzas and one tile per category. Pure, so
 * `node --test` covers it. Nothing here is a promotion: the API has none, so the home only shows
 * what the menu really sells, at its real price.
 */

export type PizzaItem = Extract<MenuItem, { kind: "PIZZA" }>;

/** Pizzas with a photo first, in menu order; up to `max`. */
export function featuredPizzas(
  sections: readonly MenuSection[],
  max: number,
): PizzaItem[] {
  const pizzas = sections
    .flatMap((section) => section.items)
    .filter((item): item is PizzaItem => item.kind === "PIZZA");
  return [
    ...pizzas.filter((pizza) => pizza.imageId),
    ...pizzas.filter((pizza) => !pizza.imageId),
  ].slice(0, max);
}

export type CategoryIcon =
  | "pizza-outline"
  | "wine-outline"
  | "ice-cream-outline"
  | "fast-food-outline"
  | "restaurant-outline";

const fold = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** An icon for a category, from what it holds and, for products, from its name. */
export function categoryIcon(section: MenuSection): CategoryIcon {
  if (section.items.some((item) => item.kind === "PIZZA"))
    return "pizza-outline";
  const name = fold(section.name);
  if (/bebida|refri|suco|cerveja|agua|drink|vinho/.test(name))
    return "wine-outline";
  if (/sobremesa|doce|sorvete|acai/.test(name)) return "ice-cream-outline";
  if (/combo|lanche|porc/.test(name)) return "fast-food-outline";
  return "restaurant-outline";
}
