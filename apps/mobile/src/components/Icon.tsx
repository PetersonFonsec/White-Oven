import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, View, type ViewStyle } from "react-native";
import { useTheme } from "../brand/theme.tsx";

/** The icon names the app uses, so a typo fails the typecheck instead of drawing a "?". */
export type IconName =
  | "add"
  | "add-circle-outline"
  | "chevron-down"
  | "create-outline"
  | "heart-outline"
  | "arrow-forward"
  | "bicycle"
  | "fast-food-outline"
  | "home"
  | "home-outline"
  | "ice-cream-outline"
  | "person"
  | "reader"
  | "reader-outline"
  | "wine-outline"
  | "arrow-back"
  | "lock-closed-outline"
  | "logo-apple"
  | "logo-google"
  | "open-outline"
  | "person-outline"
  | "mail-outline"
  | "shield-checkmark-outline"
  | "alert-circle"
  | "bag-handle"
  | "bag-handle-outline"
  | "call-outline"
  | "checkmark"
  | "checkmark-circle"
  | "checkmark-circle-outline"
  | "ellipse-outline"
  | "chevron-back"
  | "chevron-forward"
  | "close"
  | "close-circle"
  | "cloud-offline-outline"
  | "document-text-outline"
  | "eye-off-outline"
  | "eye-outline"
  | "information-circle"
  | "location-outline"
  | "log-out-outline"
  | "notifications-outline"
  | "person-circle"
  | "person-circle-outline"
  | "pizza-outline"
  | "receipt"
  | "receipt-outline"
  | "refresh"
  | "remove"
  | "restaurant"
  | "restaurant-outline"
  | "search"
  | "storefront-outline"
  | "time-outline"
  | "trash-outline"
  | "warning";

/** A decorative icon: hidden from screen readers, so the text or label next to it says it all. */
export function Icon({
  name,
  size = 22,
  color,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const theme = useTheme();
  return (
    <Ionicons
      name={name}
      size={size}
      color={color ?? theme.colors.text}
      accessible={false}
      importantForAccessibility="no"
      accessibilityElementsHidden
    />
  );
}

/**
 * A button with only an icon. The label is required (VoiceOver reads it) and the target is at
 * least 44 × 44 pt even when the icon is smaller.
 */
export function IconButton({
  name,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  disabled = false,
  tone = "plain",
  size = 22,
  style,
}: {
  name: IconName;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  disabled?: boolean;
  /** `filled` draws a round surface behind the icon, for buttons over photos or color. */
  tone?: "plain" | "filled" | "danger";
  size?: number;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const color = tone === "danger" ? theme.colors.errorText : theme.colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        {
          minWidth: 44,
          minHeight: 44,
          borderRadius: theme.radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor:
            tone === "filled"
              ? pressed
                ? theme.colors.primaryLight
                : theme.colors.surface
              : pressed
                ? theme.colors.primaryLight
                : "transparent",
          opacity: disabled ? 0.4 : 1,
        },
        tone === "filled" ? theme.shadow : null,
        style,
      ]}
    >
      <View>
        <Icon name={name} size={size} color={color} />
      </View>
    </Pressable>
  );
}
