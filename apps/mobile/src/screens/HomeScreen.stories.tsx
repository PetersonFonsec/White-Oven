import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { InlineMessage } from "../components/Feedback.tsx";
import { STORE_NAME, menuLoads, storyImageUrl } from "../storybook/fixtures.ts";
import { HomeScreen } from "./HomeScreen.tsx";
import { MENU_STALE_NOTICE } from "./store-messages.ts";

const meta = {
  title: "Telas/Início",
  component: HomeScreen,
  parameters: { aboveTabBar: true },
  args: {
    storeName: STORE_NAME,
    logoUrl: null,
    openStatus: "open",
    notices: [],
    menuStale: false,
    menu: menuLoads.ok,
    refreshing: false,
    cartCount: 0,
    imageUrl: storyImageUrl,
    onRetry: fn(),
    onOpenCart: fn(),
    onOpenPizza: fn(),
    onOpenMenu: fn(),
  },
  argTypes: {
    openStatus: { control: "select", options: ["open", "closed", null] },
    cartCount: { control: { type: "number", min: 0, max: 30 } },
  },
} satisfies Meta<typeof HomeScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Aberta: Story = {};
export const ComItensNaSacola: Story = { args: { cartCount: 3 } };
export const Fechada: Story = {
  args: {
    openStatus: "closed",
    notices: [
      `Loja fechada. ${STORE_NAME} está fora do horário de funcionamento.`,
    ],
  },
};
export const CardapioDesatualizado: Story = {
  args: { menuStale: true, notices: [MENU_STALE_NOTICE] },
};
export const ComAviso: Story = {
  args: {
    banner: (
      <InlineMessage tone="warning" title="Pedido pendente">
        Confira com a loja antes de enviar outro pedido.
      </InlineMessage>
    ),
  },
};
export const Carregando: Story = {
  args: { menu: menuLoads.loading, openStatus: null },
};
export const ErroAoCarregar: Story = { args: { menu: menuLoads.failed } };
export const CardapioVazio: Story = { args: { menu: menuLoads.empty } };
