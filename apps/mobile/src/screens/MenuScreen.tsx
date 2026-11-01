import { useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { AppBar, CartButton, FilterChips } from "../components/AppBar.tsx";
import { InlineMessage, useToast } from "../components/Feedback.tsx";
import { Body, Button, Heading } from "../components/Form.tsx";
import { Icon, IconButton } from "../components/Icon.tsx";
import { plural } from "../components/layout.ts";
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
  cartCount: number;
  /** From `menuNotices`: closed, unconfirmed, stale brand or stale menu. */
  notices: string[];
  /** The menu on screen could not be reloaded: the banner offers to try again. */
  menuStale: boolean;
  menu: MenuLoad;
  refreshing: boolean;
  imageUrl: (imageId: string) => string;
  onRetry: () => void;
  onOpenPizza: (flavorId: string) => void;
  /** The category chosen on the home, or "all". */
  category: string;
  onCategory: (id: string) => void;
  /** Back to the home tab. */
  onBack: () => void;
}

/**
 * The menu tab: categories as pills, an optional search and one card per item. A pizza card
 * opens the builder; a product card adds to the bag with its own button. Category and search
 * only shape this local view. Pull down to reload the store and the menu.
 */
export function MenuScreen({
  addingDisabled,
  banner,
  onAddProduct,
  onOpenCart,
  cartCount,
  notices,
  menuStale,
  menu,
  refreshing,
  imageUrl,
  onRetry,
  onOpenPizza,
  category,
  onCategory,
  onBack,
}: Props) {
  const theme = useTheme();
  const addProduct = useAddProduct(onAddProduct, onOpenCart);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const sections = useMemo(
    () => (menu.kind === "ok" ? menu.sections : []),
    [menu],
  );
  const selected = sections.some((section) => section.id === category)
    ? category
    : "all";
  const visibleSections = useMemo(
    () => filterMenu(sections, selected, search),
    [selected, search, sections],
  );
  const options = useMemo(
    () => [
      { value: "all", label: "Tudo" },
      ...sections.map((section) => ({
        value: section.id,
        label: section.name,
      })),
    ],
    [sections],
  );

  return (
    <Screen
      gap={theme.spacing(4)}
      header={
        <AppBar
          title="Cardápio"
          left={
            <IconButton
              name="arrow-back"
              size={26}
              accessibilityLabel="Voltar para Início"
              onPress={onBack}
            />
          }
          right={
            <>
              <IconButton
                name={searching ? "close" : "search"}
                accessibilityLabel={
                  searching ? "Fechar busca" : "Buscar no cardápio"
                }
                onPress={() => {
                  if (searching) setSearch("");
                  setSearching(!searching);
                }}
              />
              <CartButton count={cartCount} onPress={onOpenCart} />
            </>
          }
        />
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing && menu.kind === "ok"}
          onRefresh={onRetry}
          tintColor={theme.colors.accentText}
          accessibilityLabel="Atualizar cardápio"
        />
      }
    >
      {banner}
      <MenuNotices
        notices={notices}
        menuStale={menuStale}
        refreshing={refreshing}
        onRetry={onRetry}
      />
      {searching ? <SearchBar value={search} onChange={setSearch} /> : null}
      {menu.kind === "ok" && sections.length ? (
        <FilterChips
          role="tab"
          options={options}
          value={selected}
          onChange={onCategory}
        />
      ) : null}
      <MenuState menu={menu} refreshing={refreshing} onRetry={onRetry}>
        {sections.length === 0 ? (
          <EmptyMenu />
        ) : visibleSections.length === 0 ? (
          <EmptyMenu
            searched
            onClear={() => {
              setSearch("");
              onCategory("all");
            }}
          />
        ) : (
          visibleSections.map((section) => (
            <View key={section.id} style={{ gap: theme.spacing(3) }}>
              {selected === "all" ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: theme.spacing(2),
                  }}
                >
                  <Heading level="h3">{section.name}</Heading>
                  <Body small muted>
                    {plural(section.items.length, "item", "itens")}
                  </Body>
                </View>
              ) : null}
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
      </MenuState>
    </Screen>
  );
}

/** Adds a product and offers the bag in a toast once it is saved. */
export function useAddProduct(
  onAddProduct: (id: string) => Promise<string | null>,
  onOpenCart: () => void,
) {
  const toast = useToast();
  return (id: string) =>
    void onAddProduct(id).then((name) => {
      if (name)
        toast({
          text: `${name} na sacola`,
          actionLabel: "Ver sacola",
          onAction: onOpenCart,
        });
    });
}

/** Closed store, unconfirmed status, stale brand or menu: one warning, with a retry when useful. */
export function MenuNotices({
  notices,
  menuStale,
  refreshing,
  onRetry,
}: {
  notices: string[];
  menuStale: boolean;
  refreshing: boolean;
  onRetry: () => void;
}) {
  if (!notices.length) return null;
  return (
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
  );
}

/** Loading and failure of the menu; the children render once it is loaded. */
export function MenuState({
  menu,
  refreshing,
  onRetry,
  children,
}: {
  menu: MenuLoad;
  refreshing: boolean;
  onRetry: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  if (menu.kind === "loading")
    return (
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
    );
  if (menu.kind === "failed")
    return (
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
    );
  return <>{children}</>;
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
        autoFocus
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

/** A round photo of the item, or a tile with an icon. Decorative. */
export function ItemPhoto({
  item,
  imageUrl,
  size,
}: {
  item: MenuItem;
  imageUrl: string | null;
  size: number;
}) {
  const theme = useTheme();
  const radius = item.kind === "PIZZA" ? size / 2 : theme.radius.large;
  return imageUrl ? (
    <Image
      source={{ uri: imageUrl }}
      accessible={false}
      accessibilityIgnoresInvertColors
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: theme.colors.primaryLight,
      }}
    />
  ) : (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: theme.colors.primaryLight,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon
        name={item.kind === "PIZZA" ? "pizza-outline" : "restaurant-outline"}
        size={size * 0.4}
        color={theme.colors.accentText}
      />
    </View>
  );
}

/** The round "+" of a card: a real button for products, a drawing inside a pizza card. */
export function PlusMark() {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: theme.colors.primary,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name="add" size={22} color={theme.colors.onPrimary} />
    </View>
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
  const card = {
    minHeight: 112,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.xl,
    padding: theme.spacing(3),
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing(3),
  };
  const text = (
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
          fontWeight: "800",
        }}
      >
        {price}
      </Text>
    </View>
  );
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
        <ItemPhoto item={item} imageUrl={imageUrl} size={84} />
        {text}
        <View style={{ alignSelf: "flex-end" }}>
          <PlusMark />
        </View>
      </Pressable>
    );
  return (
    <View accessible={false} style={[card, theme.shadow]}>
      <ItemPhoto item={item} imageUrl={imageUrl} size={84} />
      {text}
      <View style={{ alignSelf: "flex-end", margin: -6 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Adicionar ${item.name} à sacola, ${price}`}
          accessibilityState={{ disabled: addingDisabled }}
          disabled={addingDisabled}
          onPress={() => onAddProduct(item.id)}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            opacity: addingDisabled ? 0.45 : pressed ? 0.7 : 1,
          })}
        >
          <PlusMark />
        </Pressable>
      </View>
    </View>
  );
}

export function EmptyMenu({
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
