import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { type MenuSection, formatCents } from "../menu/menu.ts";

export type MenuLoad =
  | { kind: "loading" }
  | { kind: "ok"; sections: MenuSection[] }
  | { kind: "failed" };

interface Props {
  storeName: string;
  /** From `menuNotices`: closed, unconfirmed, stale brand or stale menu. */
  notices: string[];
  /** The menu on screen could not be reloaded: the banner offers to try again. */
  menuStale: boolean;
  /** Absolute URL of the brand logo, or null. */
  logoUrl: string | null;
  menu: MenuLoad;
  refreshing: boolean;
  imageUrl: (imageId: string) => string;
  onRetry: () => void;
  onOpenPizza: (flavorId: string) => void;
}

/**
 * The store's menu (M5.2): pizzas open the builder; other products are listed with their price
 * and reach the cart in M5.3. A closed store can still be browsed, with its notice on top.
 */
export function MenuScreen({
  storeName,
  notices,
  menuStale,
  logoUrl,
  menu,
  refreshing,
  imageUrl,
  onRetry,
  onOpenPizza,
}: Props) {
  const theme = useTheme();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.cream }}
      contentContainerStyle={{
        padding: theme.spacing(4),
        gap: theme.spacing(4),
      }}
    >
      <View style={[styles.header, { gap: theme.spacing(3) }]}>
        {logoUrl ? (
          <Image
            source={{ uri: logoUrl }}
            accessibilityLabel={`Logotipo de ${storeName}`}
            resizeMode="contain"
            style={styles.logo}
          />
        ) : null}
        <Text
          accessibilityRole="header"
          style={[styles.title, { color: theme.colors.accentText }]}
        >
          {storeName}
        </Text>
      </View>
      {notices.length ? (
        <View
          accessibilityRole="alert"
          style={[
            styles.banner,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.border,
              borderRadius: theme.radius.small,
              padding: theme.spacing(3),
            },
          ]}
        >
          {notices.map((line) => (
            <Text
              key={line}
              style={[styles.body, { color: theme.colors.text }]}
            >
              {line}
            </Text>
          ))}
          {menuStale ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ busy: refreshing, disabled: refreshing }}
              disabled={refreshing}
              onPress={onRetry}
              style={styles.link}
            >
              <Text
                style={[styles.linkText, { color: theme.colors.accentText }]}
              >
                {refreshing ? "Atualizando…" : "Atualizar cardápio"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {menu.kind === "loading" ? (
        <ActivityIndicator
          accessibilityLabel="Carregando o cardápio"
          color={theme.colors.accentText}
          size="large"
        />
      ) : menu.kind === "failed" ? (
        <View style={{ gap: theme.spacing(3) }}>
          <Text style={[styles.body, { color: theme.colors.text }]}>
            Não foi possível carregar o cardápio. Confira a internet e tente de
            novo.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ busy: refreshing, disabled: refreshing }}
            disabled={refreshing}
            onPress={onRetry}
            style={({ pressed }) => [
              styles.button,
              {
                backgroundColor: pressed
                  ? theme.colors.primaryPressed
                  : theme.colors.primary,
                borderRadius: theme.radius.pill,
                paddingHorizontal: theme.spacing(5),
              },
            ]}
          >
            <Text
              style={[styles.buttonText, { color: theme.colors.onPrimary }]}
            >
              {refreshing ? "Carregando…" : "Tentar de novo"}
            </Text>
          </Pressable>
        </View>
      ) : menu.sections.length === 0 ? (
        <Text style={[styles.body, { color: theme.colors.text }]}>
          O cardápio ainda está vazio.
        </Text>
      ) : (
        menu.sections.map((section) => (
          <View key={section.id} style={{ gap: theme.spacing(2) }}>
            <Text
              accessibilityRole="header"
              style={[styles.section, { color: theme.colors.text }]}
            >
              {section.name}
            </Text>
            {section.items.map((item) => {
              const price =
                item.kind === "PIZZA"
                  ? `a partir de ${formatCents(item.fromCents)}`
                  : formatCents(item.priceCents);
              const content = (
                <>
                  {item.imageId ? (
                    // Decorative: the name next to it says what it is.
                    <Image
                      source={{ uri: imageUrl(item.imageId) }}
                      accessible={false}
                      accessibilityIgnoresInvertColors
                      style={[
                        styles.thumb,
                        { borderRadius: theme.radius.small },
                      ]}
                    />
                  ) : null}
                  <View style={styles.itemText}>
                    <Text
                      style={[styles.itemName, { color: theme.colors.text }]}
                    >
                      {item.name}
                    </Text>
                    {item.kind === "PIZZA" && item.description ? (
                      <Text
                        style={[styles.small, { color: theme.colors.muted }]}
                      >
                        {item.description}
                      </Text>
                    ) : null}
                    <Text
                      style={[styles.price, { color: theme.colors.accentText }]}
                    >
                      {price}
                    </Text>
                  </View>
                </>
              );
              const card = {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                borderRadius: theme.radius.small,
                padding: theme.spacing(3),
                gap: theme.spacing(3),
              };
              return item.kind === "PIZZA" ? (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.name}, ${price}`}
                  accessibilityHint="Abre a montagem da pizza"
                  onPress={() => onOpenPizza(item.id)}
                  style={({ pressed }) => [
                    styles.item,
                    card,
                    pressed && { borderColor: theme.colors.primary },
                  ]}
                >
                  {content}
                </Pressable>
              ) : (
                <View
                  key={item.id}
                  accessible
                  accessibilityLabel={`${item.name}, ${price}`}
                  style={[styles.item, card]}
                >
                  {content}
                </View>
              );
            })}
          </View>
        ))
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  logo: { width: 96, height: 48 },
  title: { fontSize: 28, fontWeight: "800", lineHeight: 34, flexShrink: 1 },
  banner: { borderWidth: 1, gap: 4 },
  body: { fontSize: 16, lineHeight: 24 },
  section: { fontSize: 22, fontWeight: "800" },
  item: {
    minHeight: 64,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  thumb: { width: 72, height: 72 },
  itemText: { flex: 1, gap: 2 },
  itemName: { fontSize: 18, fontWeight: "700" },
  small: { fontSize: 14, lineHeight: 20 },
  price: { fontSize: 16, fontWeight: "700" },
  button: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  buttonText: { fontSize: 16, fontWeight: "700" },
  link: { minHeight: 48, justifyContent: "center", alignSelf: "flex-start" },
  linkText: {
    fontSize: 16,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
});
