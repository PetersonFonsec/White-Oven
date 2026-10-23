export const flavors = [
  {
    id: "calabresa",
    name: "Calabresa",
    price: 4900,
    ingredients: "Calabresa, cebola e muçarela",
  },
  {
    id: "margherita",
    name: "Margherita",
    price: 5200,
    ingredients: "Tomate, manjericão e muçarela",
  },
  {
    id: "frango",
    name: "Frango com catupiry",
    price: 5900,
    ingredients: "Frango desfiado, catupiry e muçarela",
  },
  {
    id: "queijos",
    name: "Quatro queijos",
    price: 6200,
    ingredients: "Muçarela, parmesão, provolone e gorgonzola",
  },
] as const;
export type FlavorId = (typeof flavors)[number]["id"];
export type PizzaMode = "whole" | "halves";
export interface PizzaSelection {
  mode: PizzaMode;
  left: FlavorId;
  right: FlavorId;
}
export const initialSelection: PizzaSelection = {
  mode: "halves",
  left: "calabresa",
  right: "margherita",
};
export function getFlavor(id: string) {
  const flavor = flavors.find((item) => item.id === id);
  if (!flavor) throw new Error(`Sabor inválido: ${id}`);
  return flavor;
}
export function selectFlavor(
  selection: PizzaSelection,
  side: "left" | "right",
  id: string,
): PizzaSelection {
  return { ...selection, [side]: getFlavor(id).id };
}
export function selectMode(
  selection: PizzaSelection,
  mode: PizzaMode,
): PizzaSelection {
  return { ...selection, mode };
}
export function priceInCents(selection: PizzaSelection): number {
  const left = getFlavor(selection.left).price;
  return selection.mode === "whole"
    ? left
    : Math.max(left, getFlavor(selection.right).price);
}
export function describePizza(selection: PizzaSelection): string {
  const left = getFlavor(selection.left).name;
  return selection.mode === "whole"
    ? `Pizza inteira de ${left}`
    : `Metade esquerda: ${left}. Metade direita: ${getFlavor(selection.right).name}`;
}
export function formatPrice(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}
