import type { Meta, StoryObj } from "@storybook/react-native";
import { type ComponentProps, useRef } from "react";
import { fn } from "storybook/test";
import {
  demoBuilder,
  demoBuilderNoCrust,
  storyImageUrl,
} from "../storybook/fixtures.ts";
import { BuilderScreen } from "./BuilderScreen.tsx";

/** The builder fills `backRef` with its back action; the story gives it a ref of its own. */
function Builder(props: Omit<ComponentProps<typeof BuilderScreen>, "backRef">) {
  const backRef = useRef<(() => void) | null>(null);
  return <BuilderScreen {...props} backRef={backRef} />;
}

/**
 * "Monte sua pizza". The steps (Tamanho, Sabores, Borda, Adicionais) are the builder's own state:
 * tap through them inside each story. Tap "Adicionar" to see the configuration in Actions.
 */
const meta = {
  title: "Telas/Monte sua pizza",
  component: Builder,
  args: {
    addingDisabled: false,
    addError: null,
    builder: demoBuilder,
    flavorId: "calabresa",
    flavorImageUrl: storyImageUrl,
    menuStale: false,
    onBack: fn(),
    onAdd: fn(),
  },
  argTypes: {
    flavorId: {
      control: "select",
      options: [
        "calabresa",
        "marguerita",
        "portuguesa",
        "frango-catupiry",
        "quatro-queijos",
      ],
    },
  },
  // A new flavor starts a new pizza, as opening the builder again does in the app.
  render: (args) => <Builder key={args.flavorId} {...args} />,
} satisfies Meta<typeof Builder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Calabresa: Story = {};
export const SaborSemFoto: Story = { args: { flavorId: "portuguesa" } };
/** The store has no crusts: the "Borda" step is skipped. */
export const SemEtapaDeBorda: Story = {
  args: { builder: demoBuilderNoCrust },
};
export const CardapioDesatualizado: Story = { args: { menuStale: true } };
export const AdicionarDesativado: Story = { args: { addingDisabled: true } };
export const ErroAoAdicionar: Story = {
  args: {
    addError: "Não foi possível salvar na sacola. Tente de novo.",
  },
};
