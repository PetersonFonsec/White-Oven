import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { storyImageUrl } from "../storybook/fixtures.ts";
import { PizzaVisual } from "./PizzaVisual.tsx";

const photo = storyImageUrl("demo");

const meta = {
  title: "Design system/PizzaVisual",
  component: PizzaVisual,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <View style={{ alignItems: "center" }}>
        <Story />
      </View>
    ),
  ],
  args: {
    mode: "WHOLE",
    description: "Pizza inteira de Calabresa",
    leftImageUrl: photo,
    rightImageUrl: null,
    size: 240,
    activeSide: null,
  },
  argTypes: {
    mode: { control: "select", options: ["WHOLE", "HALVES"] },
    activeSide: { control: "select", options: [null, "LEFT", "RIGHT"] },
    size: { control: { type: "range", min: 120, max: 320, step: 10 } },
  },
} satisfies Meta<typeof PizzaVisual>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Whole: Story = {};
export const WholeWithoutPhoto: Story = { args: { leftImageUrl: null } };
export const Halves: Story = {
  args: {
    mode: "HALVES",
    description: "Metade Calabresa, metade Marguerita",
    rightImageUrl: photo,
  },
};
export const HalvesEditingLeft: Story = {
  args: {
    mode: "HALVES",
    description: "Metade Calabresa, metade Portuguesa",
    rightImageUrl: null,
    activeSide: "LEFT",
  },
};
export const HalvesEditingRight: Story = {
  args: { ...HalvesEditingLeft.args, activeSide: "RIGHT" },
};
