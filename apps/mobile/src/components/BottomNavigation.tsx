import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../brand/theme.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { MIN_BOTTOM_GAP, badgeText, tabAccessibilityLabel } from "./layout.ts";

export type MainTab = "menu" | "cart" | "orders" | "profile";

const TABS: readonly {
  id: MainTab;
  label: string;
  icon: IconName;
  activeIcon: IconName;
}[] = [
  {
    id: "menu",
    label: "Cardápio",
    icon: "restaurant-outline",
    activeIcon: "restaurant",
  },
  {
    id: "cart",
    label: "Sacola",
    icon: "bag-handle-outline",
    activeIcon: "bag-handle",
  },
  {
    id: "orders",
    label: "Pedidos",
    icon: "receipt-outline",
    activeIcon: "receipt",
  },
  {
    id: "profile",
    label: "Perfil",
    icon: "person-circle-outline",
    activeIcon: "person-circle",
  },
];

/**
 * The main tabs. The active tab is marked by a filled icon, bold label and a pill behind it, not
 * by color alone; the bag shows its count in a badge and in the spoken label. The bar clears the
 * home indicator with the device's real inset.
 */
export function BottomNavigation({
  selected,
  cartCount,
  onSelect,
  onHeight,
}: {
  selected: MainTab;
  cartCount: number;
  onSelect: (tab: MainTab) => void;
  /** Height of the bar, so toasts can sit above it. */
  onHeight?: (height: number) => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      onLayout={(event) => onHeight?.(event.nativeEvent.layout.height)}
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          paddingBottom: Math.max(insets.bottom, MIN_BOTTOM_GAP),
          paddingLeft: 8 + insets.left,
          paddingRight: 8 + insets.right,
        },
      ]}
    >
      {TABS.map((tab, index) => {
        const active = selected === tab.id;
        const count = tab.id === "cart" ? cartCount : 0;
        const badge = badgeText(count);
        const color = active ? theme.colors.accentText : theme.colors.muted;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tabAccessibilityLabel(
              tab.label,
              count,
              index + 1,
              TABS.length,
            )}
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(tab.id)}
            style={({ pressed }) => [
              styles.tab,
              { opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <View
              style={[
                styles.pill,
                {
                  backgroundColor: active
                    ? theme.colors.primaryLight
                    : "transparent",
                },
              ]}
            >
              <Icon
                name={active ? tab.activeIcon : tab.icon}
                size={24}
                color={color}
              />
              {badge ? (
                <View
                  style={[
                    styles.badge,
                    {
                      backgroundColor: theme.colors.primary,
                      borderColor: theme.colors.surface,
                    },
                  ]}
                >
                  <Text
                    maxFontSizeMultiplier={1.2}
                    style={[
                      styles.badgeText,
                      { color: theme.colors.onPrimary },
                    ]}
                  >
                    {badge}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={1.3}
              style={{
                color,
                fontSize: 12,
                lineHeight: 16,
                fontWeight: active ? "700" : "500",
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  pill: {
    width: 56,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: -4,
    right: 6,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontSize: 11, lineHeight: 14, fontWeight: "800" },
});
