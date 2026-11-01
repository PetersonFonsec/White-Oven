import type { Meta, StoryObj } from "@storybook/react-native";
import { type ComponentProps, useState } from "react";
import { fn } from "storybook/test";
import { demoMenu, menuLoads, storyImageUrl } from "../storybook/fixtures.ts";
import { MenuScreen } from "./MenuScreen.tsx";
import { MENU_STALE_NOTICE } from "./store-messages.ts";

/** Resolves like the app does once the product is in the bag, so the toast shows. */
const addProduct = async (id: string) => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return (
    demoMenu.simpleProducts.find((product) => product.id === id)?.name ?? null
  );
};

/** Keeps the chosen category, as App does, so the pills work inside the story. */
function MenuWithCategory(args: ComponentProps<typeof MenuScreen>) {
  const [category, setCategory] = useState(args.category);
  return (
    <MenuScreen
      {...args}
      category={category}
      onCategory={(id) => {
        setCategory(id);
        args.onCategory(id);
      }}
    />
  );
}

const meta = {
  title: "Telas/Cardápio",
  component: MenuScreen,
  render: (args) => <MenuWithCategory key={args.category} {...args} />,
  parameters: { aboveTabBar: true },
  args: {
    addingDisabled: false,
    onAddProduct: addProduct,
    onOpenCart: fn(),
    cartCount: 0,
    notices: [],
    menuStale: false,
    menu: menuLoads.ok,
    refreshing: false,
    imageUrl: storyImageUrl,
    onRetry: fn(),
    onOpenPizza: fn(),
    category: "all",
    onCategory: fn(),
    onBack: fn(),
  },
  argTypes: {
    category: {
      control: "select",
      options: ["all", "pizzas", "bebidas", "sobremesas"],
    },
  },
} satisfies Meta<typeof MenuScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tudo: Story = {};
export const SoPizzas: Story = { args: { category: "pizzas" } };
export const Bebidas: Story = { args: { category: "bebidas", cartCount: 2 } };
export const LojaFechada: Story = {
  args: {
    addingDisabled: true,
    notices: [
      "Loja fechada. Forno do Bairro está fora do horário de funcionamento.",
    ],
  },
};
export const CardapioDesatualizado: Story = {
  args: { menuStale: true, notices: [MENU_STALE_NOTICE] },
};
export const Carregando: Story = { args: { menu: menuLoads.loading } };
export const ErroAoCarregar: Story = { args: { menu: menuLoads.failed } };
export const Vazio: Story = { args: { menu: menuLoads.empty } };
