import type { Meta, StoryObj } from "@storybook/react-native";
import { Text, View } from "react-native";
import { fn } from "storybook/test";
import { Icon, IconButton, type IconName } from "./Icon.tsx";

const ALL: IconName[] = [
  "add",
  "add-circle-outline",
  "alert-circle",
  "arrow-back",
  "arrow-forward",
  "bag-handle",
  "bag-handle-outline",
  "bicycle",
  "call-outline",
  "checkmark",
  "checkmark-circle",
  "checkmark-circle-outline",
  "chevron-back",
  "chevron-down",
  "chevron-forward",
  "close",
  "close-circle",
  "cloud-offline-outline",
  "create-outline",
  "document-text-outline",
  "ellipse-outline",
  "eye-off-outline",
  "eye-outline",
  "fast-food-outline",
  "heart-outline",
  "home",
  "home-outline",
  "ice-cream-outline",
  "information-circle",
  "location-outline",
  "lock-closed-outline",
  "log-out-outline",
  "logo-apple",
  "logo-google",
  "mail-outline",
  "notifications-outline",
  "open-outline",
  "person",
  "person-circle",
  "person-circle-outline",
  "person-outline",
  "pizza-outline",
  "reader",
  "reader-outline",
  "receipt",
  "receipt-outline",
  "refresh",
  "remove",
  "restaurant",
  "restaurant-outline",
  "search",
  "shield-checkmark-outline",
  "storefront-outline",
  "time-outline",
  "trash-outline",
  "warning",
  "wine-outline",
];

const meta = {
  title: "Design system/Icon",
  component: IconButton,
  parameters: { layout: "padded" },
  args: {
    name: "add",
    accessibilityLabel: "Adicionar",
    onPress: fn(),
    tone: "plain",
    disabled: false,
  },
  argTypes: {
    name: { control: "select", options: ALL },
    tone: { control: "select", options: ["plain", "filled", "danger"] },
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Button: Story = {};
export const Filled: Story = { args: { tone: "filled" } };
export const Danger: Story = {
  args: {
    tone: "danger",
    name: "trash-outline",
    accessibilityLabel: "Remover",
  },
};
export const Disabled: Story = { args: { disabled: true } };

/** Every icon name the app uses (the `IconName` type). */
export const Catalog: Story = {
  render: () => (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      {ALL.map((name) => (
        <View key={name} style={{ width: 96, alignItems: "center", gap: 4 }}>
          <Icon name={name} size={28} />
          <Text style={{ fontSize: 10, textAlign: "center" }}>{name}</Text>
        </View>
      ))}
    </View>
  ),
};
