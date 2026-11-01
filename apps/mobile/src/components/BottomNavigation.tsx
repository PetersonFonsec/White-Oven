import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";

export type MainTab = "menu" | "cart" | "orders" | "profile";

const TABS: readonly { id: MainTab; label: string; glyph: string }[] = [
  { id: "menu", label: "Cardápio", glyph: "⌂" },
  { id: "cart", label: "Sacola", glyph: "＋" },
  { id: "orders", label: "Pedidos", glyph: "▤" },
  { id: "profile", label: "Perfil", glyph: "○" },
];

export function BottomNavigation({
  selected,
  cartCount,
  onSelect,
}: {
  selected: MainTab;
  cartCount: number;
  onSelect: (tab: MainTab) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.safeArea,
        {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          paddingBottom: Platform.OS === "ios" ? 24 : 12,
        },
      ]}
    >
      <View style={styles.row}>
        {TABS.map((tab) => {
          const active = selected === tab.id;
          const label =
            tab.id === "cart" && cartCount > 0
              ? `Sacola ${cartCount}`
              : tab.label;
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected: active }}
              onPress={() => onSelect(tab.id)}
              style={({ pressed }) => [
                styles.tab,
                {
                  backgroundColor: active
                    ? theme.colors.primaryLight
                    : "transparent",
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Text
                accessible={false}
                style={{
                  color: active ? theme.colors.accentText : theme.colors.muted,
                  fontSize: 20,
                  lineHeight: 22,
                  fontWeight: "700",
                }}
              >
                {tab.glyph}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  color: active ? theme.colors.accentText : theme.colors.muted,
                  fontSize: 11,
                  lineHeight: 16,
                  fontWeight: active ? "700" : "500",
                }}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  row: {
    minHeight: 60,
    paddingHorizontal: 12,
    paddingTop: 5,
    flexDirection: "row",
    justifyContent: "space-around",
    gap: 8,
  },
  tab: {
    flex: 1,
    minHeight: 48,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    gap: 2,
  },
});
