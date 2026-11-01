import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { Button } from "./Form.tsx";
import { InlineMessage, useToast } from "./Feedback.tsx";

const meta = {
  title: "Design system/InlineMessage",
  component: InlineMessage,
  parameters: { layout: "padded" },
  args: {
    tone: "info",
    title: "Loja fechada agora",
    children: "Você pode montar seu pedido e enviar quando a loja abrir.",
  },
  argTypes: {
    tone: {
      control: "select",
      options: ["error", "warning", "info", "success"],
    },
  },
} satisfies Meta<typeof InlineMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {};
export const Success: Story = {
  args: {
    tone: "success",
    title: "Pedido enviado",
    children: "A loja recebeu seu pedido.",
  },
};
export const Warning: Story = {
  args: {
    tone: "warning",
    title: undefined,
    children: "O cardápio pode estar desatualizado.",
  },
};
export const ErrorWithAction: Story = {
  args: {
    tone: "error",
    title: "Não foi possível carregar",
    children: "Confira a internet e tente de novo.",
    action: (
      <Button
        label="Tentar de novo"
        variant="outline"
        size="small"
        onPress={fn()}
      />
    ),
  },
};

function ToastDemo() {
  const toast = useToast();
  return (
    <>
      <Button
        label="Mostrar toast"
        onPress={() => toast({ text: "Adicionado à sacola" })}
      />
      <Button
        variant="outline"
        label="Toast com ação"
        onPress={() =>
          toast({
            text: "Refrigerante 2 L adicionado",
            actionLabel: "Ver sacola",
            onAction: () => {},
          })
        }
      />
    </>
  );
}

/** Tap the buttons: the toast appears at the bottom for 4 s (6 s with an action). */
export const Toast: Story = { render: () => <ToastDemo /> };
