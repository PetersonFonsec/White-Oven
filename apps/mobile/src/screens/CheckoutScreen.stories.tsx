import type { Meta, StoryObj } from "@storybook/react-native";
import { type ComponentProps, useState } from "react";
import { fn } from "storybook/test";
import {
  baseState,
  demoAddress,
  demoCart,
  demoCheckoutSettings,
  demoMenu,
  signedInState,
  storyModel,
} from "../storybook/fixtures.ts";
import { CheckoutScreen, EMPTY_DRAFT } from "./CheckoutScreen.tsx";

/** Keeps the form draft, as App does, so the choices work inside the story. */
function Bag(args: ComponentProps<typeof CheckoutScreen>) {
  const [draft, setDraft] = useState(args.draft);
  return (
    <CheckoutScreen
      {...args}
      draft={draft}
      onDraft={(next) => {
        setDraft(next);
        args.onDraft(next);
      }}
    />
  );
}

/** "Sacola". Asking the store's total and confirming do nothing here. */
const meta = {
  title: "Telas/Sacola",
  component: CheckoutScreen,
  args: {
    model: storyModel(),
    state: { ...signedInState, cart: demoCart },
    menu: demoMenu,
    settings: demoCheckoutSettings,
    canOrder: true,
    recoveryOnly: false,
    stale: false,
    draft: EMPTY_DRAFT,
    onDraft: fn(),
    onBack: fn(),
    onAccount: fn(),
    onAddAddress: fn(),
    onTrackOrder: fn(),
    onRefresh: fn(),
  },
  render: (args) => <Bag {...args} />,
} satisfies Meta<typeof CheckoutScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Retirada: Story = {};
export const Entrega: Story = {
  args: {
    draft: {
      ...EMPTY_DRAFT,
      fulfillment: "DELIVERY",
      addressId: demoAddress.id,
      paymentMethod: "PIX_ON_DELIVERY",
    },
  },
};
export const SemLogin: Story = {
  args: { state: { ...baseState, cart: demoCart } },
};
export const Vazia: Story = { args: { state: signedInState } };
export const LojaFechada: Story = { args: { canOrder: false } };
export const CardapioDesatualizado: Story = { args: { stale: true } };
