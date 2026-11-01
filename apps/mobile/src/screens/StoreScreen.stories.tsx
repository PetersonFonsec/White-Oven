import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { Button } from "../components/Form.tsx";
import { STORE_NAME } from "../storybook/fixtures.ts";
import { StoreScreen } from "./StoreScreen.tsx";

const meta = {
  title: "Telas/Loja indisponível",
  component: StoreScreen,
  args: {
    message: {
      screen: "unavailable",
      title: "Pizzaria indisponível",
      body: `${STORE_NAME} não está recebendo pedidos por este aplicativo no momento.`,
      notice: null,
    },
    refreshing: false,
    onRetry: fn(),
  },
} satisfies Meta<typeof StoreScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Indisponivel: Story = {};
export const Fechada: Story = {
  args: {
    message: {
      screen: "closed",
      title: "Loja fechada",
      body: `${STORE_NAME} pausou os pedidos até 19:30.`,
      notice: null,
    },
  },
};
export const SemConexao: Story = {
  args: {
    message: {
      screen: "unavailable",
      title: "Pizzaria indisponível",
      body: `${STORE_NAME} não está recebendo pedidos por este aplicativo no momento.`,
      notice: "Sem conexão. Mostrando a última versão salva da pizzaria.",
    },
  },
};
export const Atualizando: Story = { args: { refreshing: true } };
export const ComAcoes: Story = {
  args: {
    actions: (
      <Button variant="outline" label="Meus pedidos" onPress={() => {}} />
    ),
  },
};
