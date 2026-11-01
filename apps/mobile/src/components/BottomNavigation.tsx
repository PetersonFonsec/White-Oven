import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../brand/theme.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { MIN_BOTTOM_GAP, tabAccessibilityLabel } from "./layout.ts";

export type MainTab = "home" | "menu" | "orders" | "profile";

const TABS: readonly {
  id: MainTab;
  label: string;
  icon: IconName;
  activeIcon: IconName;
}[] = [
  { id: "home", label: "Início", icon: "home-outline", activeIcon: "home" },
  {
    id: "menu",
    label: "Cardápio",
    icon: "reader-outline",
    activeIcon: "reader",
  },
  {
    id: "orders",
    label: "Pedidos",
    icon: "bag-handle-outline",
    activeIcon: "bag-handle",
  },
  {
    id: "profile",
    label: "Perfil",
    icon: "person-outline",
    activeIcon: "person",
  },
];

/**
 * The main tabs. The active tab is marked by a filled icon, bold label and a pill behind it, not
 * by color alone. The bag lives in the top bar of the screens, with its count. The bar clears the
 * home indicator with the device's real inset.
 */
export function BottomNavigation({
  selected,
  onSelect,
  onHeight,
}: {
  selected: MainTab;
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
        const color = active ? theme.colors.accentText : theme.colors.muted;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityLabel={tabAccessibilityLabel(
              tab.label,
              0,
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
});
