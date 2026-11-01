import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { fn } from "storybook/test";
import { STORE_NAME } from "../storybook/fixtures.ts";
import { AppBar, BrandWordmark, CartButton, FilterChips } from "./AppBar.tsx";
import { IconButton } from "./Icon.tsx";

const meta = {
  title: "Design system/AppBar",
  component: AppBar,
  args: { storeName: STORE_NAME, logoUrl: null },
} satisfies Meta<typeof AppBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The home's bar: the store's wordmark and the bag with its count. */
export const StoreWithCart: Story = {
  args: { right: <CartButton count={3} onPress={fn()} /> },
};

export const EmptyCart: Story = {
  args: { right: <CartButton count={0} onPress={fn()} /> },
};

export const ManyItems: Story = {
  args: { right: <CartButton count={12} onPress={fn()} /> },
};

export const PlainTitle: Story = {
  args: {
    title: "Meus pedidos",
    left: (
      <IconButton
        name="arrow-back"
        accessibilityLabel="Voltar"
        onPress={fn()}
      />
    ),
    right: <CartButton count={1} onPress={fn()} />,
  },
};

export const Wordmark: StoryObj<typeof BrandWordmark> = {
  parameters: { layout: "padded" },
  render: () => (
    <>
      <BrandWordmark storeName={STORE_NAME} logoUrl={null} />
      <BrandWordmark storeName="Pizzaria Centro" logoUrl={null} />
      <BrandWordmark storeName="Forno" logoUrl={null} />
    </>
  ),
};

const categories = [
  { value: "all", label: "Tudo" },
  { value: "pizzas", label: "Pizzas" },
  { value: "bebidas", label: "Bebidas" },
  { value: "sobremesas", label: "Sobremesas" },
  { value: "combos", label: "Combos" },
] as const;

function ChipsDemo() {
  const [value, setValue] =
    useState<(typeof categories)[number]["value"]>("all");
  return (
    <FilterChips
      role="tab"
      options={categories}
      value={value}
      onChange={setValue}
    />
  );
}

export const Chips: StoryObj<typeof FilterChips> = {
  parameters: { layout: "padded" },
  render: () => <ChipsDemo />,
};
