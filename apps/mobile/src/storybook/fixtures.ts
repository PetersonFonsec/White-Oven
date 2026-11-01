/**
 * Demo data for the Storybook stories (`pnpm storybook`). Everything goes through the same parsers
 * the app uses on the API's answers (`parseMenu`, `parseCustomerOrderDetail`), so a story shows
 * exactly what the app would show for that answer. Nothing here is imported by the app itself.
 */
import { Image } from "react-native";
import type { CommerceModel, CommerceState } from "../cart/model.ts";
import { builderMenu } from "../builder/builder.ts";
import type { CartLine } from "../cart/cart.ts";
import type { CheckoutSettings } from "../cart/summary.ts";
import type { Address, Profile } from "../customer/client.ts";
import type { LegalState } from "../customer/legal.ts";
import {
  type CustomerOrderDetail,
  type CustomerOrderStatus,
  type CustomerOrderSummary,
  parseCustomerOrderDetail,
} from "../customer/orders.ts";
import { type MenuSection, menuSections, parseMenu } from "../menu/menu.ts";
import type { MenuLoad } from "../screens/MenuScreen.tsx";

export const STORE_NAME = "Forno do Bairro";

// The only pizza photo in the repository; the stories use it for every flavor that has an image.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const photoAsset: unknown = require("../../assets/whiteoven-kit/pizza-hero.png");
/** A bundled image as a URL: Metro's asset on the phone, the file's address on the web. */
function assetUri(asset: unknown): string | null {
  if (typeof asset === "string") return asset;
  if (typeof Image.resolveAssetSource === "function")
    return Image.resolveAssetSource(asset as number)?.uri ?? null;
  const uri = (asset as { uri?: unknown } | null)?.uri;
  return typeof uri === "string" ? uri : null;
}
const pizzaPhoto = assetUri(photoAsset);
/** Stands in for the API's image route: every image id shows the demo photo. */
export const storyImageUrl = (imageId: string) =>
  imageId ? (pizzaPhoto ?? "") : "";
export const heroImageUrl = pizzaPhoto;

const PHOTO = "0b5f6a1e-2d4c-4f7e-9a3b-6c1d2e3f4a5b";
const flavor = (
  id: string,
  name: string,
  description: string | null,
  ingredientIds: string[],
  photo = true,
) => ({
  id,
  categoryId: "pizzas",
  name,
  description,
  imageId: photo ? PHOTO : null,
  ingredientIds,
});
const prices = (flavorId: string, grande: number, media: number) => [
  { flavorId, sizeId: "grande", priceCents: grande },
  { flavorId, sizeId: "media", priceCents: media },
  { flavorId, sizeId: "broto", priceCents: Math.round(media * 0.7) },
];

/** A public menu as `GET /v1/public/stores/{slug}/menu` answers it. */
export const apiMenu = {
  version: 12,
  categories: [
    { id: "pizzas", name: "Pizzas", kind: "PIZZA" },
    { id: "bebidas", name: "Bebidas", kind: "PRODUCT" },
    { id: "sobremesas", name: "Sobremesas", kind: "PRODUCT" },
  ],
  sizes: [
    { id: "grande", name: "Grande", slices: 8, maxFlavors: 2 },
    { id: "media", name: "Média", slices: 6, maxFlavors: 2 },
    { id: "broto", name: "Broto", slices: 4, maxFlavors: 1 },
  ],
  ingredients: [
    { id: "mussarela", name: "Mussarela", removable: false },
    { id: "calabresa-fatiada", name: "Calabresa", removable: false },
    { id: "cebola", name: "Cebola", removable: true },
    { id: "tomate", name: "Tomate", removable: true },
    { id: "manjericao", name: "Manjericão", removable: true },
    { id: "azeitona", name: "Azeitona", removable: true },
    { id: "ovo", name: "Ovo", removable: true },
    { id: "presunto", name: "Presunto", removable: false },
    { id: "frango", name: "Frango desfiado", removable: false },
    { id: "catupiry-recheio", name: "Catupiry", removable: true },
  ],
  flavors: [
    flavor("calabresa", "Calabresa", "Calabresa fatiada, cebola e azeitona", [
      "mussarela",
      "calabresa-fatiada",
      "cebola",
      "azeitona",
    ]),
    flavor(
      "marguerita",
      "Marguerita",
      "Mussarela, tomate e manjericão fresco",
      ["mussarela", "tomate", "manjericao"],
    ),
    flavor(
      "portuguesa",
      "Portuguesa",
      "Presunto, ovo, cebola e azeitona",
      ["mussarela", "presunto", "ovo", "cebola", "azeitona"],
      false,
    ),
    flavor(
      "frango-catupiry",
      "Frango com catupiry",
      "Frango desfiado coberto com catupiry",
      ["mussarela", "frango", "catupiry-recheio"],
    ),
    flavor("quatro-queijos", "Quatro queijos", null, ["mussarela"], false),
  ],
  flavorPrices: [
    ...prices("calabresa", 5490, 4590),
    ...prices("marguerita", 4990, 4190),
    ...prices("portuguesa", 5690, 4790),
    ...prices("frango-catupiry", 5890, 4990),
    ...prices("quatro-queijos", 6290, 5290),
  ],
  crusts: [
    { id: "catupiry", name: "Catupiry" },
    { id: "cheddar", name: "Cheddar" },
  ],
  crustPrices: [
    { crustId: "catupiry", sizeId: "grande", priceCents: 900 },
    { crustId: "catupiry", sizeId: "media", priceCents: 700 },
    { crustId: "cheddar", sizeId: "grande", priceCents: 900 },
  ],
  extras: [
    { id: "bacon", name: "Bacon" },
    { id: "milho", name: "Milho" },
    { id: "parmesao", name: "Parmesão" },
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
      sizeId: "media",
      wholePriceCents: 500,
      halfPriceCents: 300,
    },
    {
      extraId: "milho",
      sizeId: "grande",
      wholePriceCents: 300,
      halfPriceCents: 200,
    },
    {
      extraId: "parmesao",
      sizeId: "grande",
      wholePriceCents: 500,
      halfPriceCents: 300,
    },
  ],
  simpleProducts: [
    {
      id: "refri-2l",
      categoryId: "bebidas",
      name: "Refrigerante 2 L",
      priceCents: 1400,
      imageId: null,
    },
    {
      id: "suco",
      categoryId: "bebidas",
      name: "Suco de laranja 500 ml",
      priceCents: 900,
      imageId: null,
    },
    {
      id: "brownie",
      categoryId: "sobremesas",
      name: "Brownie com sorvete",
      priceCents: 1800,
      imageId: null,
    },
  ],
  pricingPolicy: {
    halfAndHalfStrategy: "HIGHEST",
    halfAndHalfSurchargeCents: 200,
    maxExtrasPerHalf: 2,
  },
};

export const demoMenu = parseMenu(apiMenu)!;
export const demoSections: MenuSection[] = menuSections(demoMenu);
export const demoBuilder = builderMenu(demoMenu);
/** The same menu without crusts: the builder skips the "Borda" step. */
export const demoBuilderNoCrust = builderMenu(
  parseMenu({ ...apiMenu, crusts: [], crustPrices: [] })!,
);

export const menuLoads = {
  ok: { kind: "ok", sections: demoSections },
  loading: { kind: "loading" },
  failed: { kind: "failed" },
  empty: { kind: "ok", sections: [] },
} satisfies Record<string, MenuLoad>;

// ----- Customer, bag and orders -----

export const demoProfile: Profile = {
  id: "5d0f1e2a-3b4c-4d5e-8f60-718293a4b5c6",
  name: "Maria Souza",
  email: "maria@exemplo.com",
  phone: "(11) 98765-4321",
  legalUpdateRequired: false,
};

export const demoAddress: Address = {
  id: "8a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
  label: "Casa",
  postalCode: "01310-100",
  street: "Avenida Paulista",
  number: "1000",
  complement: "Apto 52",
  district: "Bela Vista",
  city: "São Paulo",
  state: "SP",
  reference: null,
};

export const demoCart: CartLine[] = [
  {
    id: "c1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8",
    kind: "PIZZA",
    name: "Pizza",
    pizza: {
      sizeId: "grande",
      mode: "HALVES",
      flavors: { LEFT: "calabresa", RIGHT: "marguerita" },
      crustId: "catupiry",
      extras: [{ extraId: "bacon", placement: "LEFT" }],
      removals: [{ ingredientId: "cebola", placement: "LEFT" }],
      quantity: 1,
    },
  },
  {
    id: "d2b3c4d5-e6f7-4a81-92a3-b4c5d6e7f809",
    kind: "PRODUCT",
    name: "Refrigerante 2 L",
    productId: "refri-2l",
    quantity: 2,
  },
];

export const demoCheckoutSettings: CheckoutSettings = {
  fulfillmentModes: ["DELIVERY", "PICKUP"],
  acceptedPaymentMethods: ["CASH", "CARD_ON_DELIVERY", "PIX_ON_DELIVERY"],
  deliveryFeeCents: 800,
  minimumOrderCents: 3000,
  deliveryAreaDescription: "Entregamos em até 5 km da loja.",
  pickupAddress: "Rua das Flores, 120 - Centro",
};

export const legalReady: LegalState = {
  status: "ready",
  legal: {
    termsOfUse: {
      kind: "TERMS_OF_USE",
      version: "demo-2026-10",
      body: "Termos de uso de demonstração.\n\nEste texto só existe no Storybook.",
      publishedAt: "2026-10-01T12:00:00.000Z",
    },
    privacyPolicy: {
      kind: "PRIVACY_POLICY",
      version: "demo-2026-10",
      body: "Política de privacidade de demonstração.\n\nEste texto só existe no Storybook.",
      publishedAt: "2026-10-01T12:00:00.000Z",
    },
  },
};

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const orderIds = {
  preparing: "0a1b2c3d-1111-4aaa-8bbb-000000000001",
  outForDelivery: "0a1b2c3d-1111-4aaa-8bbb-000000000002",
  completed: "0a1b2c3d-1111-4aaa-8bbb-000000000003",
  canceled: "0a1b2c3d-1111-4aaa-8bbb-000000000004",
  placed: "0a1b2c3d-1111-4aaa-8bbb-000000000005",
  pickupReady: "0a1b2c3d-1111-4aaa-8bbb-000000000006",
};
export type DemoOrder = keyof typeof orderIds;

const pizzaItem = {
  kind: "PIZZA",
  quantity: 1,
  unitPriceCents: 6990,
  totalCents: 6990,
  snapshot: {
    size: { id: "grande", name: "Grande" },
    mode: "HALVES",
    flavors: {
      LEFT: { id: "calabresa", name: "Calabresa" },
      RIGHT: { id: "marguerita", name: "Marguerita" },
    },
    crust: { id: "catupiry", name: "Catupiry" },
    extras: [{ id: "bacon", name: "Bacon", placement: "LEFT" }],
    removals: [{ id: "cebola", name: "Cebola", placement: "LEFT" }],
  },
};
const productItem = {
  kind: "PRODUCT",
  quantity: 2,
  unitPriceCents: 1400,
  totalCents: 2800,
  snapshot: { product: { id: "refri-2l", name: "Refrigerante 2 L" } },
};

/** The status path each order went through, oldest first. */
const paths: Record<CustomerOrderStatus, CustomerOrderStatus[]> = {
  PLACED: ["PLACED"],
  PREPARING: ["PLACED", "PREPARING"],
  READY: ["PLACED", "PREPARING", "READY"],
  OUT_FOR_DELIVERY: ["PLACED", "PREPARING", "READY", "OUT_FOR_DELIVERY"],
  COMPLETED: ["PLACED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED"],
  REJECTED: ["PLACED", "REJECTED"],
  CANCELED: ["PLACED", "CANCELED"],
};

function order(
  key: DemoOrder,
  number: number,
  status: CustomerOrderStatus,
  fulfillment: "DELIVERY" | "PICKUP",
  placedMinutesAgo: number,
): CustomerOrderDetail {
  const deliveryFeeCents = fulfillment === "DELIVERY" ? 800 : 0;
  const path = paths[status];
  return parseCustomerOrderDetail({
    id: orderIds[key],
    number,
    status,
    placedAt: minutesAgo(placedMinutesAgo),
    fulfillment,
    totalCents: 9790 + deliveryFeeCents,
    itemsSubtotalCents: 9790,
    deliveryFeeCents,
    discountCents: 0,
    paymentMethod: "PIX_ON_DELIVERY",
    changeForCents: null,
    notes: "Sem cebola na metade de calabresa, por favor.",
    items: [pizzaItem, productItem],
    history: path.map((to, index) => ({
      from: index === 0 ? null : path[index - 1],
      to,
      reasonCode: to === "CANCELED" ? "CUSTOMER_REQUEST" : null,
      at: minutesAgo(placedMinutesAgo - index * 8),
    })),
    estimate: { prepMinutes: 25, deliveryMinutes: 20 },
    contactPhone: "(11) 3333-4444",
  });
}

export const demoOrders: Record<DemoOrder, CustomerOrderDetail> = {
  placed: order("placed", 1048, "PLACED", "DELIVERY", 2),
  preparing: order("preparing", 1047, "PREPARING", "DELIVERY", 12),
  outForDelivery: order(
    "outForDelivery",
    1046,
    "OUT_FOR_DELIVERY",
    "DELIVERY",
    35,
  ),
  pickupReady: order("pickupReady", 1045, "READY", "PICKUP", 30),
  completed: order("completed", 1032, "COMPLETED", "DELIVERY", 60 * 26),
  canceled: order("canceled", 1020, "CANCELED", "PICKUP", 60 * 24 * 6),
};

const summaryOf = ({
  id,
  number,
  status,
  placedAt,
  fulfillment,
  totalCents,
}: CustomerOrderDetail): CustomerOrderSummary => ({
  id,
  number,
  status,
  placedAt,
  fulfillment,
  totalCents,
});

// ----- A commerce model that never calls the API -----

export const baseState: CommerceState = {
  version: 1,
  cart: [],
  pending: null,
  receipt: null,
  ready: true,
  session: "restored",
  busy: false,
  error: null,
  profile: null,
  addresses: [],
  quote: null,
};

export const signedInState: CommerceState = {
  ...baseState,
  profile: demoProfile,
  addresses: [demoAddress],
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Only the methods the screens call, answering from the demo data after a short delay so the
 * loading states show. Actions that would change something (sign in, confirm, cancel) do nothing
 * and report failure, so a story never leaves its state.
 */
export function storyModel(
  options: {
    orders?: CustomerOrderDetail[];
    /** The order list never answers: the loading state stays on screen. */
    listPending?: boolean;
    /** The order list fails. */
    listFails?: boolean;
  } = {},
): CommerceModel {
  const orders = options.orders ?? Object.values(demoOrders);
  const model = {
    init: async () => true,
    signIn: async () => {
      await wait(600);
      return false;
    },
    quote: async () => false,
    invalidateQuote: () => {},
    confirm: async () => false,
    acknowledgePending: async () => false,
    changeCart: async () => false,
    replaceCart: async () => false,
    cancelCustomerOrder: async () => null,
    listCustomerOrders: async () => {
      if (options.listPending) await new Promise(() => {});
      await wait(400);
      if (options.listFails) throw new Error("Sem conexão com a pizzaria.");
      return { orders: orders.map(summaryOf), nextCursor: null };
    },
    getCustomerOrder: async (id: string) => {
      await wait(300);
      const found = orders.find((entry) => entry.id === id);
      if (!found) throw new Error("Pedido não encontrado.");
      return found;
    },
  };
  return model as unknown as CommerceModel;
}
