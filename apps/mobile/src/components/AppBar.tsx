import type { ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../brand/theme.tsx";
import { brandNameParts } from "../customer/auth-flow.ts";
import { Icon, IconButton } from "./Icon.tsx";
import { PAGE_GUTTER, badgeText, plural } from "./layout.ts";

/** The store's logo (or a pizza) and its name in two tones. Never WhiteOven's (ADR 0020). */
export function BrandWordmark({
  storeName,
  logoUrl,
}: {
  storeName: string;
  logoUrl: string | null;
}) {
  const theme = useTheme();
  const { lead, tail } = brandNameParts(storeName);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: theme.spacing(2),
        flexShrink: 1,
      }}
    >
      {logoUrl ? (
        <Image
          source={{ uri: logoUrl }}
          accessible={false}
          resizeMode="contain"
          style={{ width: 34, height: 34, borderRadius: 8 }}
        />
      ) : (
        <Icon name="pizza-outline" size={28} color={theme.colors.accentText} />
      )}
      <Text
        accessibilityRole="header"
        accessibilityLabel={storeName}
        numberOfLines={1}
        maxFontSizeMultiplier={1.4}
        style={{
          flexShrink: 1,
          color: theme.colors.text,
          fontSize: 22,
          lineHeight: 28,
          fontWeight: "800",
          letterSpacing: -0.3,
        }}
      >
        {lead}
        {tail ? (
          <Text style={{ color: theme.colors.accentText }}>{tail}</Text>
        ) : null}
      </Text>
    </View>
  );
}

/** The bag button with its count, in a top bar. */
export function CartButton({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const badge = badgeText(count);
  return (
    <View>
      <IconButton
        name="bag-handle-outline"
        size={26}
        accessibilityLabel={
          count ? `Sacola, ${plural(count, "item", "itens")}` : "Sacola"
        }
        onPress={onPress}
      />
      {badge ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 2,
            right: 0,
            minWidth: 20,
            height: 20,
            borderRadius: 10,
            paddingHorizontal: 5,
            backgroundColor: theme.colors.primary,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text
            maxFontSizeMultiplier={1.2}
            style={{
              color: theme.colors.onPrimary,
              fontSize: 12,
              fontWeight: "800",
            }}
          >
            {badge}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The top bar of the main screens: something on the left (a back button or nothing), the store's
 * wordmark or a title in the middle and actions on the right. It clears the status bar.
 */
export function AppBar({
  left,
  title,
  storeName,
  logoUrl,
  right,
}: {
  left?: ReactNode;
  /** A plain title instead of the store's wordmark. */
  title?: string;
  storeName?: string;
  logoUrl?: string | null;
  right?: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + theme.spacing(1),
        paddingBottom: theme.spacing(1),
        paddingLeft: theme.spacing(2) + insets.left,
        paddingRight: theme.spacing(2) + insets.right,
        minHeight: insets.top + 56,
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: theme.colors.background,
      }}
    >
      <View style={{ width: 96, flexDirection: "row" }}>{left}</View>
      <View style={{ flex: 1, alignItems: "center" }}>
        {title ? (
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            maxFontSizeMultiplier={1.4}
            style={{
              color: theme.colors.text,
              fontSize: theme.typography.h3.fontSize,
              lineHeight: theme.typography.h3.lineHeight,
              fontWeight: "800",
            }}
          >
            {title}
          </Text>
        ) : (
          <BrandWordmark
            storeName={storeName ?? ""}
            logoUrl={logoUrl ?? null}
          />
        )}
      </View>
      <View
        style={{ width: 96, flexDirection: "row", justifyContent: "flex-end" }}
      >
        {right}
      </View>
    </View>
  );
}

/** A row of pill filters that scrolls under the page margins; the chosen one is filled. */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  role = "button",
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  /** `tab` when the chips switch what the list shows, like categories. */
  role?: "button" | "tab";
}) {
  const theme = useTheme();
  return (
    <ScrollView
      horizontal
      accessibilityRole={role === "tab" ? "tablist" : undefined}
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -PAGE_GUTTER, flexGrow: 0 }}
      contentContainerStyle={{
        gap: theme.spacing(2),
        paddingHorizontal: PAGE_GUTTER,
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole={role}
            accessibilityLabel={
              role === "tab"
                ? `${option.label}, ${index + 1} de ${options.length}`
                : `Filtrar: ${option.label}`
            }
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => ({
              minHeight: 44,
              paddingHorizontal: theme.spacing(4),
              borderRadius: theme.radius.pill,
              justifyContent: "center",
              borderWidth: 1,
              borderColor: selected
                ? theme.colors.primary
                : theme.colors.border,
              backgroundColor: selected
                ? pressed
                  ? theme.colors.primaryPressed
                  : theme.colors.primary
                : pressed
                  ? theme.colors.primaryLight
                  : theme.colors.surface,
            })}
          >
            <Text
              style={{
                color: selected ? theme.colors.onPrimary : theme.colors.text,
                ...theme.typography.bodySmall,
                fontWeight: selected ? "700" : "500",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
