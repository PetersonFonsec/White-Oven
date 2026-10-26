/** A public menu as the API sends it (M2.6 plus the M5.2 image ids), for the menu and builder tests. */
export const IMAGE = "0b5f6a1e-2d4c-4f7e-9a3b-6c1d2e3f4a5b";

export const apiMenu = () => ({
  store: { slug: "pizzaria-bairro", name: "Forno do Bairro" },
  version: 7,
  categories: [
    { id: "pizzas", name: "Pizzas", kind: "PIZZA" },
    { id: "vazia", name: "Sem itens", kind: "PRODUCT" },
    { id: "bebidas", name: "Bebidas", kind: "PRODUCT" },
  ],
  sizes: [
    { id: "grande", name: "Grande", slices: 8, maxFlavors: 2 },
    { id: "broto", name: "Broto", slices: 4, maxFlavors: 1 },
  ],
  ingredients: [
    { id: "calabresa-fatiada", name: "Calabresa", removable: false },
    { id: "cebola", name: "Cebola", removable: true },
    { id: "tomate", name: "Tomate", removable: true },
    { id: "azeitona", name: "Azeitona", removable: true },
  ],
  flavors: [
    {
      id: "calabresa",
      categoryId: "pizzas",
      name: "Calabresa",
      description: "Calabresa fatiada e cebola",
      imageId: IMAGE,
      ingredientIds: ["calabresa-fatiada", "cebola", "azeitona"],
    },
    {
      id: "marguerita",
      categoryId: "pizzas",
      name: "Marguerita",
      description: null,
      imageId: null,
      ingredientIds: ["tomate"],
    },
    {
      id: "especial",
      categoryId: "pizzas",
      name: "Especial da casa",
      description: "  ",
      imageId: null,
      ingredientIds: [],
    },
  ],
  flavorPrices: [
    { flavorId: "calabresa", sizeId: "grande", priceCents: 5000 },
    { flavorId: "calabresa", sizeId: "broto", priceCents: 3000 },
    { flavorId: "marguerita", sizeId: "grande", priceCents: 4500 },
    { flavorId: "especial", sizeId: "grande", priceCents: 6200 },
  ],
  crusts: [{ id: "catupiry", name: "Catupiry" }],
  crustPrices: [{ crustId: "catupiry", sizeId: "grande", priceCents: 800 }],
  extras: [
    { id: "bacon", name: "Bacon" },
    { id: "cheddar", name: "Cheddar" },
    { id: "milho", name: "Milho" },
  ],
  extraPrices: [
    {
      extraId: "bacon",
      sizeId: "grande",
      wholePriceCents: 600,
      halfPriceCents: 350,
    },
    {
      extraId: "bacon",
      sizeId: "broto",
      wholePriceCents: 400,
      halfPriceCents: 250,
    },
    {
      extraId: "cheddar",
      sizeId: "grande",
      wholePriceCents: 500,
      halfPriceCents: 300,
    },
    {
      extraId: "milho",
      sizeId: "grande",
      wholePriceCents: 300,
      halfPriceCents: 200,
    },
  ],
  simpleProducts: [
    {
      id: "suco",
      categoryId: "bebidas",
      name: "Suco de laranja",
      priceCents: 900,
      imageId: null,
    },
  ],
  pricingPolicy: {
    halfAndHalfStrategy: "HIGHEST",
    halfAndHalfSurchargeCents: 200,
    maxExtrasPerHalf: 2,
  },
});
