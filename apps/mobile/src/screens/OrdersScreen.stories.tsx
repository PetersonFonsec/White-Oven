import type { Meta, StoryObj } from "@storybook/react-native";
import { type ComponentProps, useState } from "react";
import { fn } from "storybook/test";
import {
  STORE_NAME,
  baseState,
  demoMenu,
  demoOrders,
  signedInState,
  storyImageUrl,
  storyModel,
} from "../storybook/fixtures.ts";
import { OrdersScreen } from "./OrdersScreen.tsx";

/** Opens and closes orders inside the story, as App does with `orderId`. */
function Orders(args: ComponentProps<typeof OrdersScreen>) {
  const [orderId, setOrderId] = useState(args.orderId);
  return (
    <OrdersScreen
      {...args}
      orderId={orderId}
      onOpenOrder={(id) => {
        setOrderId(id);
        args.onOpenOrder(id);
      }}
      onBack={() => {
        setOrderId(null);
        args.onBack();
      }}
    />
  );
}

/**
 * "Pedidos" and "Acompanhar pedido". The orders come from demo data after a short delay; cancel,
 * reorder and sign-in do nothing here.
 */
const meta = {
  title: "Telas/Pedidos",
  component: OrdersScreen,
  parameters: { aboveTabBar: true },
  args: {
    model: storyModel(),
    state: signedInState,
    menu: demoMenu,
    menuStale: false,
    storeUnavailable: false,
    orderId: null,
    backTo: "Pedidos",
    onBack: fn(),
    onAccount: fn(),
    onOpenOrder: fn(),
    onOpenCart: fn(),
    onOpenMenu: fn(),
    storeName: STORE_NAME,
    logoUrl: null,
    cartCount: 0,
    imageUrl: storyImageUrl,
  },
  render: (args) => <Orders key={args.orderId ?? "list"} {...args} />,
} satisfies Meta<typeof OrdersScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MeusPedidos: Story = {};
export const SemPedidos: Story = {
  args: { model: storyModel({ orders: [] }) },
};
export const Carregando: Story = {
  args: { model: storyModel({ listPending: true }) },
};
export const ErroAoCarregar: Story = {
  args: { model: storyModel({ listFails: true }) },
};
export const SemLogin: Story = { args: { state: baseState } };

/** "Acompanhar pedido": a delivery being prepared. */
export const AcompanharEmPreparo: Story = {
  parameters: { aboveTabBar: false },
  args: { orderId: demoOrders.preparing.id },
};
export const AcompanharRecemFeito: Story = {
  parameters: { aboveTabBar: false },
  args: { orderId: demoOrders.placed.id },
};
export const AcompanharSaiuParaEntrega: Story = {
  parameters: { aboveTabBar: false },
  args: { orderId: demoOrders.outForDelivery.id },
};
export const AcompanharProntoParaRetirar: Story = {
  parameters: { aboveTabBar: false },
  args: { orderId: demoOrders.pickupReady.id },
};
export const DetalheEntregue: Story = {
  parameters: { aboveTabBar: false },
  args: { orderId: demoOrders.completed.id },
};
export const DetalheCancelado: Story = {
  parameters: { aboveTabBar: false },
  args: { orderId: demoOrders.canceled.id },
};
