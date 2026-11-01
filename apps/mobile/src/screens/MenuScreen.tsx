import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { InlineMessage, useToast } from "../components/Feedback.tsx";
import { Body, Button, Heading } from "../components/Form.tsx";
import { Icon, IconButton } from "../components/Icon.tsx";
import { PAGE_GUTTER, plural } from "../components/layout.ts";
import { Screen } from "../components/Screen.tsx";
import { type MenuItem, type MenuSection, formatCents } from "../menu/menu.ts";
import { filterMenu } from "../menu/search.ts";

export type MenuLoad =
  | { kind: "loading" }
  | { kind: "ok"; sections: MenuSection[] }
  | { kind: "failed" };

/** Whether the store takes orders now, as the header pill shows it; null when unconfirmed. */
export type OpenStatus = "open" | "closed" | null;

interface Props {
  addingDisabled: boolean;
  /** Errors of the app that belong above the menu (secure storage, bag). */
  banner?: ReactNode;
  /** Resolves to the product name once it is saved in the bag, or null. */
  onAddProduct: (id: string) => Promise<string | null>;
  onOpenCart: () => void;
  storeName: string;
  openStatus: OpenStatus;
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
 * The home of the app: the store, a featured pizza, search, categories and the menu. Category
 * filters and search only shape this local view. Pull down to reload the store and the menu.
 */
export function MenuScreen({
  addingDisabled,
  banner,
  onAddProduct,
  onOpenCart,
  storeName,
  openStatus,
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
  const toast = useToast();
  const addProduct = (id: string) =>
    void onAddProduct(id).then((name) => {
      if (name)
        toast({
          text: `${name} na sacola`,
          actionLabel: "Ver sacola",
          onAction: onOpenCart,
        });
    });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const sections = useMemo(
    () => (menu.kind === "ok" ? menu.sections : []),
    [menu],
  );
  const hero = sections
    .flatMap((section) => section.items)
    .find((item) => item.kind === "PIZZA" && item.imageId);
  const visibleSections = useMemo(
    () => filterMenu(sections, category, search),
    [category, search, sections],
  );
  const filtering = !!search.trim() || category !== "all";

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing && menu.kind === "ok"}
          onRefresh={onRetry}
          tintColor={theme.colors.accentText}
          accessibilityLabel="Atualizar cardápio"
        />
      }
    >
      <StoreHeader
        storeName={storeName}
        logoUrl={logoUrl}
        openStatus={openStatus}
      />
      {banner}
      {notices.length ? (
        <InlineMessage
          tone="warning"
          action={
            menuStale ? (
              <Button
                label="Atualizar cardápio"
                icon="refresh"
                loading={refreshing}
                variant="secondary"
                size="small"
                onPress={onRetry}
              />
            ) : undefined
          }
        >
          {notices.join("\n")}
        </InlineMessage>
      ) : null}

      <Heading level="h1">O que vai pedir hoje?</Heading>

      {hero && hero.kind === "PIZZA" && !filtering ? (
        <Hero
          item={hero}
          imageUrl={imageUrl(hero.imageId!)}
          onPress={() => onOpenPizza(hero.id)}
        />
      ) : null}

      {menu.kind === "ok" && sections.length ? (
        <View style={{ gap: theme.spacing(3) }}>
          <SearchBar value={search} onChange={setSearch} />
          <CategoryTabs
            sections={sections}
            selected={category}
            onSelect={setCategory}
          />
        </View>
      ) : null}

      {menu.kind === "loading" ? (
        <View
          style={{
            paddingVertical: theme.spacing(6),
            alignItems: "center",
            gap: theme.spacing(3),
          }}
        >
          <ActivityIndicator
            accessibilityLabel="Carregando o cardápio"
            color={theme.colors.accentText}
            size="large"
          />
          <Body muted>Carregando o cardápio…</Body>
        </View>
      ) : menu.kind === "failed" ? (
        <InlineMessage
          tone="error"
          title="Não foi possível carregar o cardápio"
          action={
            <Button
              label="Tentar de novo"
              icon="refresh"
              variant="primary"
              size="medium"
              loading={refreshing}
              onPress={onRetry}
            />
          }
        >
          Confira a conexão com a internet e tente novamente.
        </InlineMessage>
      ) : sections.length === 0 ? (
        <EmptyMenu />
      ) : visibleSections.length === 0 ? (
        <EmptyMenu
          searched
          onClear={() => {
            setSearch("");
            setCategory("all");
          }}
        />
      ) : (
        visibleSections.map((section) => (
          <View key={section.id} style={{ gap: theme.spacing(3) }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: theme.spacing(2),
              }}
            >
              <Heading level="h2">{section.name}</Heading>
              <Body small muted>
                {plural(section.items.length, "item", "itens")}
              </Body>
            </View>
            {section.items.map((item) => (
              <MenuItemCard
                key={item.id}
                item={item}
                imageUrl={item.imageId ? imageUrl(item.imageId) : null}
                addingDisabled={addingDisabled}
                onOpenPizza={onOpenPizza}
                onAddProduct={addProduct}
              />
            ))}
          </View>
        ))
      )}
    </Screen>
  );
}

function StoreHeader({
  storeName,
  logoUrl,
  openStatus,
}: {
  storeName: string;
  logoUrl: string | null;
  openStatus: OpenStatus;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.spacing(3),
      }}
    >
      {logoUrl ? (
        <Image
          source={{ uri: logoUrl }}
          accessibilityLabel={`Logotipo de ${storeName}`}
          resizeMode="contain"
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            backgroundColor: theme.colors.surface,
          }}
        />
      ) : (
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            backgroundColor: theme.colors.primaryLight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name="pizza-outline"
            size={26}
            color={theme.colors.accentText}
          />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.text,
            fontSize: theme.typography.title.fontSize,
            lineHeight: theme.typography.title.lineHeight,
            fontWeight: "800",
          }}
        >
          {storeName}
        </Text>
        {openStatus ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {/* Dot and word: the state never depends on color alone. */}
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor:
                  openStatus === "open"
                    ? theme.colors.success
                    : theme.colors.muted,
              }}
            />
            <Text
              style={{
                color:
                  openStatus === "open"
                    ? theme.colors.success
                    : theme.colors.textSecondary,
                fontSize: theme.typography.bodySmall.fontSize,
                lineHeight: theme.typography.bodySmall.lineHeight,
                fontWeight: "600",
              }}
            >
              {openStatus === "open" ? "Aberta agora" : "Fechada agora"}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function Hero({
  item,
  imageUrl,
  onPress,
}: {
  item: Extract<MenuItem, { kind: "PIZZA" }>;
  imageUrl: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Destaque: ${item.name}, a partir de ${formatCents(item.fromCents)}`}
      accessibilityHint="Abre a montagem da pizza"
      onPress={onPress}
      style={({ pressed }) => [
        {
          borderRadius: theme.radius.xl,
          backgroundColor: theme.colors.surface,
          overflow: "hidden",
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
        theme.shadow,
      ]}
    >
      <Image
        source={{ uri: imageUrl }}
        accessible={false}
        accessibilityIgnoresInvertColors
        resizeMode="cover"
        style={{
          width: "100%",
          aspectRatio: 2,
          backgroundColor: theme.colors.primaryLight,
        }}
      />
      {/* Text below the photo, never over it: it grows with the font size and keeps contrast. */}
      <View style={{ padding: theme.spacing(4), gap: theme.spacing(1) }}>
        <Text
          style={{
            color: theme.colors.accentText,
            fontSize: theme.typography.caption.fontSize,
            lineHeight: theme.typography.caption.lineHeight,
            fontWeight: "800",
            letterSpacing: 0.6,
          }}
        >
          DESTAQUE
        </Text>
        <Text
          style={{
            color: theme.colors.text,
            fontSize: theme.typography.h3.fontSize,
            lineHeight: theme.typography.h3.lineHeight,
            fontWeight: "800",
          }}
        >
          {item.name}
        </Text>
        {item.description ? (
          <Body small muted>
            {item.description}
          </Body>
        ) : null}
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: theme.spacing(2),
            marginTop: theme.spacing(2),
          }}
        >
          <Text
            style={{
              color: theme.colors.text,
              fontSize: theme.typography.title.fontSize,
              lineHeight: theme.typography.title.lineHeight,
              fontWeight: "700",
            }}
          >
            a partir de {formatCents(item.fromCents)}
          </Text>
          <View
            style={{
              minHeight: 44,
              paddingHorizontal: theme.spacing(4),
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.primary,
              justifyContent: "center",
            }}
          >
            <Text
              style={{
                color: theme.colors.onPrimary,
                fontSize: theme.typography.button.fontSize,
                lineHeight: theme.typography.button.lineHeight,
                fontWeight: "700",
              }}
            >
              Montar pizza
            </Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

function SearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        minHeight: 50,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: theme.spacing(3),
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.inputBorder,
        borderRadius: theme.radius.pill,
        gap: theme.spacing(2),
      }}
    >
      <Icon name="search" size={20} color={theme.colors.muted} />
      <TextInput
        accessibilityLabel="Buscar no cardápio"
        placeholder="Buscar pizza ou bebida"
        placeholderTextColor={theme.colors.placeholder}
        value={value}
        onChangeText={onChange}
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="never"
        selectionColor={theme.colors.primary}
        style={{
          flex: 1,
          minHeight: 48,
          color: theme.colors.text,
          fontSize: theme.typography.body.fontSize,
        }}
      />
      {value ? (
        <IconButton
          name="close-circle"
          accessibilityLabel="Limpar busca"
          onPress={() => onChange("")}
        />
      ) : (
        <View style={{ width: theme.spacing(3) }} />
      )}
    </View>
  );
}

function CategoryTabs({
  sections,
  selected,
  onSelect,
}: {
  sections: MenuSection[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const theme = useTheme();
  const tabs = [{ id: "all", name: "Tudo" }, ...sections];
  return (
    <ScrollView
      horizontal
      accessibilityRole="tablist"
      showsHorizontalScrollIndicator={false}
      // Bleeds to the screen edges, so chips scroll under the margin instead of being cut there.
      style={{ marginHorizontal: -PAGE_GUTTER }}
      contentContainerStyle={{
        gap: theme.spacing(2),
        paddingHorizontal: PAGE_GUTTER,
      }}
    >
      {tabs.map((section, index) => {
        const active = selected === section.id;
        return (
          <Pressable
            key={section.id}
            accessibilityRole="tab"
            accessibilityLabel={`${section.name}, ${index + 1} de ${tabs.length}`}
            accessibilityState={{ selected: active }}
            onPress={() => onSelect(section.id)}
            style={({ pressed }) => ({
              minHeight: 44,
              paddingHorizontal: theme.spacing(4),
              justifyContent: "center",
              borderRadius: theme.radius.pill,
              backgroundColor: active
                ? theme.colors.text
                : theme.colors.surface,
              borderWidth: active ? 0 : 1,
              borderColor: theme.colors.border,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Text
              style={{
                color: active ? theme.colors.surface : theme.colors.text,
                fontSize: theme.typography.bodySmall.fontSize,
                lineHeight: theme.typography.bodySmall.lineHeight,
                fontWeight: active ? "700" : "500",
              }}
            >
              {section.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/**
 * A pizza card is one button that opens the builder; a product card has its own add button,
 * so the two actions never sit on top of each other.
 */
function MenuItemCard({
  item,
  imageUrl,
  addingDisabled,
  onOpenPizza,
  onAddProduct,
}: {
  item: MenuItem;
  imageUrl: string | null;
  addingDisabled: boolean;
  onOpenPizza: (id: string) => void;
  onAddProduct: (id: string) => void;
}) {
  const theme = useTheme();
  const price =
    item.kind === "PIZZA"
      ? `a partir de ${formatCents(item.fromCents)}`
      : formatCents(item.priceCents);
  const body = (
    <>
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          accessible={false}
          accessibilityIgnoresInvertColors
          style={{
            width: 88,
            height: 88,
            borderRadius: theme.radius.medium,
            backgroundColor: theme.colors.primaryLight,
          }}
        />
      ) : (
        <View
          style={{
            width: 88,
            height: 88,
            borderRadius: theme.radius.medium,
            backgroundColor: theme.colors.primaryLight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name={
              item.kind === "PIZZA" ? "pizza-outline" : "restaurant-outline"
            }
            size={32}
            color={theme.colors.accentText}
          />
        </View>
      )}
      <View style={{ flex: 1, gap: 4 }}>
        <Text
          style={{
            color: theme.colors.text,
            fontSize: theme.typography.title.fontSize,
            lineHeight: theme.typography.title.lineHeight,
            fontWeight: "700",
          }}
        >
          {item.name}
        </Text>
        {item.kind === "PIZZA" && item.description ? (
          <Text
            numberOfLines={2}
            style={{
              color: theme.colors.textSecondary,
              fontSize: theme.typography.bodySmall.fontSize,
              lineHeight: theme.typography.bodySmall.lineHeight,
            }}
          >
            {item.description}
          </Text>
        ) : null}
        <Text
          style={{
            color: theme.colors.text,
            fontSize: theme.typography.body.fontSize,
            lineHeight: theme.typography.body.lineHeight,
            fontWeight: "700",
          }}
        >
          {price}
        </Text>
      </View>
    </>
  );
  const card = {
    minHeight: 112,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.large,
    padding: theme.spacing(3),
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing(3),
  };
  if (item.kind === "PIZZA")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${price}`}
        accessibilityHint="Abre a montagem da pizza"
        onPress={() => onOpenPizza(item.id)}
        style={({ pressed }) => [
          card,
          theme.shadow,
          { opacity: pressed ? 0.85 : 1 },
        ]}
      >
        {body}
        <Icon name="chevron-forward" size={22} color={theme.colors.muted} />
      </Pressable>
    );
  return (
    <View accessible={false} style={[card, theme.shadow]}>
      {body}
      <IconButton
        name="add"
        tone="filled"
        accessibilityLabel={`Adicionar ${item.name} à sacola, ${price}`}
        disabled={addingDisabled}
        onPress={() => onAddProduct(item.id)}
      />
    </View>
  );
}

function EmptyMenu({
  searched = false,
  onClear,
}: {
  searched?: boolean;
  onClear?: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        padding: theme.spacing(5),
        alignItems: "center",
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.large,
        gap: theme.spacing(2),
      }}
    >
      <Icon
        name={searched ? "search" : "pizza-outline"}
        size={36}
        color={theme.colors.accentText}
      />
      <Heading level="h3" centered>
        {searched ? "Nada encontrado" : "Cardápio vazio"}
      </Heading>
      <Body muted centered>
        {searched
          ? "Tente outro termo ou veja todas as categorias."
          : "Esta loja ainda não adicionou produtos ao cardápio."}
      </Body>
      {searched && onClear ? (
        <Button
          label="Limpar busca e filtros"
          size="medium"
          onPress={onClear}
        />
      ) : null}
    </View>
  );
}
