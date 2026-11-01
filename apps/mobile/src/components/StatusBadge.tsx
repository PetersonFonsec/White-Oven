import { Text, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { statusTone } from "../customer/order-progress.ts";
import type { CustomerOrderStatus, Fulfillment } from "../customer/orders.ts";
import { statusLabel } from "../customer/orders.ts";
import { Icon, type IconName } from "./Icon.tsx";

const icons: Record<ReturnType<typeof statusTone>, IconName> = {
  progress: "time-outline",
  success: "checkmark-circle",
  error: "close-circle",
};

/**
 * An order's status as a pill. The label is always written and the icon changes with it, so the
 * status never depends on color; the text stays dark for contrast on every tint.
 */
export function StatusBadge({
  status,
  fulfillment,
}: {
  status: CustomerOrderStatus;
  fulfillment: Fulfillment;
}) {
  const theme = useTheme();
  const tone = statusTone(status);
  const tint = {
    progress: {
      background: theme.colors.orangeSoft,
      icon: theme.colors.accentText,
    },
    success: {
      background: theme.colors.successSurface,
      icon: theme.colors.success,
    },
    error: {
      background: theme.colors.errorSurface,
      icon: theme.colors.errorText,
    },
  }[tone];
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing(1),
        backgroundColor: tint.background,
        borderRadius: theme.radius.pill,
        paddingHorizontal: theme.spacing(2) + 2,
        paddingVertical: theme.spacing(1),
      }}
    >
      <Icon name={icons[tone]} size={16} color={tint.icon} />
      <Text
        style={{
          color: theme.colors.text,
          fontSize: theme.typography.caption.fontSize,
          lineHeight: theme.typography.caption.lineHeight,
          fontWeight: "700",
        }}
      >
        {statusLabel(status, fulfillment)}
      </Text>
    </View>
  );
}
