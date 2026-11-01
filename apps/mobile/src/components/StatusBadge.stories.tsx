import type { Meta, StoryObj } from "@storybook/react-native";
import { ORDER_STATUSES } from "../customer/orders.ts";
import { StatusBadge } from "./StatusBadge.tsx";

const meta = {
  title: "Design system/StatusBadge",
  component: StatusBadge,
  parameters: { layout: "padded" },
  args: { status: "PREPARING", fulfillment: "DELIVERY" },
  argTypes: {
    status: { control: "select", options: [...ORDER_STATUSES] },
    fulfillment: { control: "select", options: ["DELIVERY", "PICKUP"] },
  },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

/** Every status, for delivery and for pickup. */
export const AllStatuses: Story = {
  render: () => (
    <>
      {ORDER_STATUSES.map((status) => (
        <StatusBadge key={status} status={status} fulfillment="DELIVERY" />
      ))}
      {ORDER_STATUSES.map((status) => (
        <StatusBadge
          key={`pickup-${status}`}
          status={status}
          fulfillment="PICKUP"
        />
      ))}
    </>
  ),
};
