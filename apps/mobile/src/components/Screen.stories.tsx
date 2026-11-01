import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { fn } from "storybook/test";
import { BottomNavigation, type MainTab } from "./BottomNavigation.tsx";
import { Body, Button, Heading, SurfaceCard } from "./Form.tsx";
import { Screen, ScreenHeader, StickyFooter } from "./Screen.tsx";

const meta = {
  title: "Design system/ScreenHeader",
  component: ScreenHeader,
  args: { title: "Monte sua pizza", onBack: fn(), backTo: "Cardápio" },
} satisfies Meta<typeof ScreenHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithBack: Story = {};
export const WithSubtitle: Story = {
  args: { title: "Pedido #1047", subtitle: "Entrega · hoje às 19:42" },
};
export const Large: Story = {
  args: { title: "Pedidos", large: true, onBack: undefined, backTo: undefined },
};
export const BackDisabled: Story = { args: { backDisabled: true } };

/** A whole screen: header, scrolling content and a sticky footer. */
export const ScreenWithFooter: Story = {
  render: (args) => (
    <Screen
      header={<ScreenHeader {...args} />}
      footer={
        <StickyFooter>
          <Button label="Adicionar · R$ 54,90" onPress={() => {}} />
        </StickyFooter>
      }
    >
      {Array.from({ length: 8 }, (_, index) => (
        <SurfaceCard key={index}>
          <Heading level="title">{`Bloco ${index + 1}`}</Heading>
          <Body muted>Conteúdo que rola por baixo do rodapé fixo.</Body>
        </SurfaceCard>
      ))}
    </Screen>
  ),
};

function TabsDemo() {
  const [tab, setTab] = useState<MainTab>("home");
  return (
    <>
      <Screen header={<ScreenHeader title="Abas" large />}>
        <Body>{`Aba escolhida: ${tab}`}</Body>
      </Screen>
      <BottomNavigation selected={tab} onSelect={setTab} />
    </>
  );
}

/** The main tabs at the bottom of the app. */
export const Tabs: StoryObj<typeof BottomNavigation> = {
  parameters: { aboveTabBar: true },
  render: () => <TabsDemo />,
};
