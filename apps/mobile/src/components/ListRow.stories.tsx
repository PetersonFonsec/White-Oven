import type { Meta, StoryObj } from "@storybook/react-native";
import { Switch } from "react-native";
import { fn } from "storybook/test";
import { ListRow, Section } from "./ListRow.tsx";
import { TotalRow } from "./TotalRow.tsx";
import { SurfaceCard } from "./Form.tsx";

const meta = {
  title: "Design system/ListRow",
  component: ListRow,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <Section title="Conta" footer="Rodapé da seção, com uma explicação.">
        <Story />
      </Section>
    ),
  ],
  args: {
    first: true,
    title: "Endereços",
    subtitle: "Casa · Avenida Paulista, 1000",
    icon: "location-outline",
    onPress: fn(),
    destructive: false,
    disabled: false,
  },
} satisfies Meta<typeof ListRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pressable: Story = {};
export const WithTrailing: Story = {
  args: {
    title: "Notificações do pedido",
    subtitle: undefined,
    icon: "notifications-outline",
    onPress: undefined,
    trailing: <Switch value />,
  },
};
export const Destructive: Story = {
  args: {
    title: "Sair da conta",
    subtitle: undefined,
    icon: "log-out-outline",
    destructive: true,
  },
};
export const Disabled: Story = { args: { disabled: true } };

/** A full section as the profile shows it. */
export const FullSection: Story = {
  decorators: [],
  render: () => (
    <Section title="Conta">
      <ListRow
        first
        icon="person-outline"
        title="Dados pessoais"
        subtitle="Maria Souza"
        onPress={() => {}}
      />
      <ListRow
        icon="location-outline"
        title="Endereços"
        subtitle="1 endereço"
        onPress={() => {}}
      />
      <ListRow
        icon="document-text-outline"
        title="Termos de uso"
        subtitle="Versão demo-2026-10"
        onPress={() => {}}
      />
      <ListRow
        icon="log-out-outline"
        title="Sair da conta"
        destructive
        onPress={() => {}}
      />
    </Section>
  ),
};

/** The totals of the bag and of an order. */
export const Totals: Story = {
  decorators: [],
  render: () => (
    <SurfaceCard>
      <TotalRow label="Subtotal" value="R$ 97,90" />
      <TotalRow label="Entrega" value="R$ 8,00" />
      <TotalRow label="Desconto" value="-R$ 5,00" />
      <TotalRow label="Total" value="R$ 100,90" strong />
    </SurfaceCard>
  ),
};
