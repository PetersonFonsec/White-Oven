/**
 * Example catalog from docs/product/pizza-builder-rules.md#exemplos (size Grande, landing flavor prices),
 * plus the items the normalization cases and error tests need.
 */
import { validatePizzaCatalog } from "@whiteoven/contracts";

const flavor = (id, name, ingredientIds, extra = {}) => ({
  id,
  categoryId: "pizzas",
  name,
  ingredientIds,
  available: true,
  archived: false,
  ...extra,
});
const item = (id, name, extra = {}) => ({
  id,
  name,
  available: true,
  archived: false,
  ...extra,
});

const raw = {
  categories: [
    { id: "pizzas", kind: "PIZZA", archived: false },
    { id: "bebidas", kind: "PRODUCT", archived: false },
  ],
  sizes: [
    { ...item("grande", "Grande"), slices: 8, maxFlavors: 2 },
    { ...item("broto", "Broto"), slices: 4, maxFlavors: 1 },
    {
      ...item("gigante", "Gigante", { available: false }),
      slices: 12,
      maxFlavors: 2,
    },
  ],
  ingredients: [
    { id: "mussarela", name: "Mussarela", removable: false, archived: false },
    { id: "calabresa", name: "Calabresa", removable: false, archived: false },
    { id: "cebola", name: "Cebola", removable: true, archived: false },
    { id: "tomate", name: "Tomate", removable: true, archived: false },
    { id: "manjericao", name: "Manjericão", removable: true, archived: false },
    { id: "presunto", name: "Presunto", removable: false, archived: false },
    { id: "ovo", name: "Ovo", removable: true, archived: false },
    { id: "ervilha", name: "Ervilha", removable: true, archived: false },
    { id: "provolone", name: "Provolone", removable: false, archived: false },
  ],
  flavors: [
    flavor("calabresa", "Calabresa", ["mussarela", "calabresa", "cebola"]),
    flavor("margherita", "Margherita", ["mussarela", "tomate", "manjericao"]),
    flavor("portuguesa", "Portuguesa", [
      "mussarela",
      "presunto",
      "ovo",
      "cebola",
      "ervilha",
    ]),
    flavor("quatro-queijos", "Quatro queijos", ["mussarela", "provolone"]),
    flavor("frango", "Frango", ["mussarela"], { archived: true }),
    flavor("atum", "Atum", ["mussarela", "cebola"], { available: false }),
    flavor("sem-preco", "Sem preço no Grande", ["mussarela"]),
  ],
  flavorPrices: [
    ["calabresa", 4900],
    ["margherita", 5200],
    ["portuguesa", 5595],
    ["quatro-queijos", 6200],
    ["frango", 5000],
    ["atum", 5300],
  ]
    .flatMap(([flavorId, priceCents]) => [
      { flavorId, sizeId: "grande", priceCents },
      { flavorId, sizeId: "broto", priceCents: priceCents - 2000 },
      { flavorId, sizeId: "gigante", priceCents: priceCents + 2000 },
    ])
    .concat({ flavorId: "sem-preco", sizeId: "broto", priceCents: 3000 }),
  crusts: [
    item("catupiry", "Catupiry"),
    item("tradicional", "Tradicional"),
    item("cheddar", "Cheddar", { archived: true }),
  ],
  crustPrices: [
    { crustId: "catupiry", sizeId: "grande", priceCents: 1000 },
    { crustId: "tradicional", sizeId: "grande", priceCents: 0 },
    { crustId: "cheddar", sizeId: "grande", priceCents: 1200 },
  ],
  extras: [
    item("bacon", "Bacon"),
    item("azeitona", "Azeitona"),
    item("milho", "Milho"),
    item("palmito", "Palmito", { available: false }),
    item("rucula", "Rúcula"),
  ],
  extraPrices: [
    {
      extraId: "bacon",
      sizeId: "grande",
      wholePriceCents: 800,
      halfPriceCents: 500,
    },
    {
      extraId: "azeitona",
      sizeId: "grande",
      wholePriceCents: 400,
      halfPriceCents: 250,
    },
    {
      extraId: "milho",
      sizeId: "grande",
      wholePriceCents: 300,
      halfPriceCents: 150,
    },
    {
      extraId: "palmito",
      sizeId: "grande",
      wholePriceCents: 600,
      halfPriceCents: 300,
    },
  ],
};

const validated = validatePizzaCatalog(raw);
if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
export const catalog = validated.value;

export const policy = (overrides = {}) => ({
  halfAndHalfStrategy: "HIGHEST",
  halfAndHalfSurchargeCents: 0,
  maxExtrasPerHalf: 5,
  ...overrides,
});

export const whole = (flavorId, overrides = {}) => ({
  sizeId: "grande",
  mode: "WHOLE",
  flavors: { LEFT: flavorId },
  crustId: null,
  extras: [],
  removals: [],
  quantity: 1,
  ...overrides,
});

export const halves = (left, right, overrides = {}) => ({
  sizeId: "grande",
  mode: "HALVES",
  flavors: { LEFT: left, RIGHT: right },
  crustId: null,
  extras: [],
  removals: [],
  quantity: 1,
  ...overrides,
});

export const extra = (extraId, placement) => ({ extraId, placement });
export const removal = (ingredientId, placement) => ({
  ingredientId,
  placement,
});
