import {
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "../a11y/useReducedMotion.ts";
import { useTheme } from "../brand/theme.tsx";
import { AppBar, CartButton } from "../components/AppBar.tsx";
import { Body } from "../components/Form.tsx";
import { Icon } from "../components/Icon.tsx";
import { PAGE_GUTTER } from "../components/layout.ts";
import { Screen } from "../components/Screen.tsx";
import { slideAt } from "../customer/auth-flow.ts";
import { type PizzaItem, categoryIcon, featuredPizzas } from "../menu/home.ts";
import { formatCents } from "../menu/menu.ts";
import {
  EmptyMenu,
  ItemPhoto,
  type MenuLoad,
  MenuNotices,
  MenuState,
  type OpenStatus,
  PlusMark,
} from "./MenuScreen.tsx";

interface Props {
  storeName: string;
  logoUrl: string | null;
  openStatus: OpenStatus;
  /** Errors of the app that belong on top (secure storage, bag, pending order). */
  banner?: ReactNode;
  notices: string[];
  menuStale: boolean;
  menu: MenuLoad;
  refreshing: boolean;
  cartCount: number;
  imageUrl: (imageId: string) => string;
  onRetry: () => void;
  onOpenCart: () => void;
  onOpenPizza: (flavorId: string) => void;
  /** Opens the menu tab, on a category or on everything ("all"). */
  onOpenMenu: (category: string) => void;
}

/**
 * The home tab: the store, a headline, featured pizzas in a carousel, one tile per category and a
 * row of highlights. Everything comes from the store's menu at its real price; the API has no
 * promotions, so none are shown.
 */
export function HomeScreen({
  storeName,
  logoUrl,
  openStatus,
  banner,
  notices,
  menuStale,
  menu,
  refreshing,
  cartCount,
  imageUrl,
  onRetry,
  onOpenCart,
  onOpenPizza,
  onOpenMenu,
}: Props) {
  const theme = useTheme();
  const sections = menu.kind === "ok" ? menu.sections : [];
  const featured = useMemo(() => featuredPizzas(sections, 3), [sections]);
  const highlights = useMemo(() => featuredPizzas(sections, 8), [sections]);
  return (
    <Screen
      gap={theme.spacing(5)}
      header={
        <AppBar
          storeName={storeName}
          logoUrl={logoUrl}
          right={<CartButton count={cartCount} onPress={onOpenCart} />}
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
      <View style={{ gap: theme.spacing(2) }}>
        {openStatus ? <OpenPill open={openStatus === "open"} /> : null}
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.text,
            fontSize: theme.typography.display.fontSize,
            lineHeight: theme.typography.display.lineHeight,
            fontWeight: "800",
            letterSpacing: -0.5,
          }}
        >
          Sua pizza favorita,{" "}
          <Text style={{ color: theme.colors.accentText }}>
            do jeito que você gosta
          </Text>
        </Text>
        <Body muted>
          Monte inteira ou meio a meio, escolha borda e adicionais e acompanhe o
          pedido até chegar.
        </Body>
      </View>

      <MenuState menu={menu} refreshing={refreshing} onRetry={onRetry}>
        {sections.length === 0 ? (
          <EmptyMenu />
        ) : (
          <>
            {featured.length ? (
              <FeaturedCarousel
                pizzas={featured}
                imageUrl={imageUrl}
                onOpenPizza={onOpenPizza}
              />
            ) : null}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginHorizontal: -PAGE_GUTTER, flexGrow: 0 }}
              contentContainerStyle={{
                gap: theme.spacing(3),
                paddingHorizontal: PAGE_GUTTER,
                paddingVertical: theme.spacing(1),
              }}
            >
              {sections.map((section) => (
                <Pressable
                  key={section.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${section.name}, ver no cardápio`}
                  onPress={() => onOpenMenu(section.id)}
                  style={({ pressed }) => [
                    {
                      width: 84,
                      minHeight: 84,
                      padding: theme.spacing(2),
                      borderRadius: theme.radius.large,
                      backgroundColor: pressed
                        ? theme.colors.primaryLight
                        : theme.colors.surface,
                      alignItems: "center",
                      justifyContent: "center",
                      gap: theme.spacing(1),
                    },
                    theme.shadow,
                  ]}
                >
                  <Icon
                    name={categoryIcon(section)}
                    size={28}
                    color={theme.colors.accentText}
                  />
                  <Text
                    numberOfLines={2}
                    style={{
                      textAlign: "center",
                      color: theme.colors.text,
                      ...theme.typography.caption,
                    }}
                  >
                    {section.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {highlights.length ? (
              <View style={{ gap: theme.spacing(3) }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Text
                    accessibilityRole="header"
                    style={{ color: theme.colors.text, ...theme.typography.h3 }}
                  >
                    Destaques
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Ver todo o cardápio"
                    onPress={() => onOpenMenu("all")}
                    hitSlop={6}
                    style={{
                      minHeight: 44,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 2,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.colors.accentText,
                        ...theme.typography.bodySmall,
                        fontWeight: "700",
                      }}
                    >
                      Ver todos
                    </Text>
                    <Icon
                      name="chevron-forward"
                      size={16}
                      color={theme.colors.accentText}
                    />
                  </Pressable>
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ marginHorizontal: -PAGE_GUTTER, flexGrow: 0 }}
                  contentContainerStyle={{
                    gap: theme.spacing(3),
                    paddingHorizontal: PAGE_GUTTER,
                    paddingBottom: theme.spacing(2),
                  }}
                >
                  {highlights.map((pizza) => (
                    <HighlightCard
                      key={pizza.id}
                      pizza={pizza}
                      imageUrl={pizza.imageId ? imageUrl(pizza.imageId) : null}
                      onPress={() => onOpenPizza(pizza.id)}
                    />
                  ))}
                </ScrollView>
              </View>
            ) : null}
          </>
        )}
      </MenuState>
    </Screen>
  );
}

/** "Aberta agora" or "Fechada agora": a dot and the word, never color alone. */
function OpenPill({ open }: { open: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: theme.spacing(3),
        paddingVertical: theme.spacing(1),
        borderRadius: theme.radius.pill,
        backgroundColor: open
          ? theme.colors.successSurface
          : theme.colors.surfaceSecondary,
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: open ? theme.colors.success : theme.colors.muted,
        }}
      />
      <Text
        style={{
          color: open ? theme.colors.success : theme.colors.textSecondary,
          ...theme.typography.caption,
          fontWeight: "700",
        }}
      >
        {open ? "Aberta agora" : "Fechada agora"}
      </Text>
    </View>
  );
}

/**
 * Featured pizzas: a large photo and, under it, an orange card with the name, the real price and
 * an arrow. One page per pizza; dots below say where you are and jump between them.
 */
function FeaturedCarousel({
  pizzas,
  imageUrl,
  onOpenPizza,
}: {
  pizzas: PizzaItem[];
  imageUrl: (imageId: string) => string;
  onOpenPizza: (id: string) => void;
}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = window.width - 2 * PAGE_GUTTER - insets.left - insets.right;
  const [page, setPage] = useState(0);
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <View style={{ gap: theme.spacing(2) }}>
      <ScrollView
        ref={list}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) =>
          setPage(
            slideAt(event.nativeEvent.contentOffset.x, width, pizzas.length),
          )
        }
      >
        {pizzas.map((pizza) => (
          <Pressable
            key={pizza.id}
            accessibilityRole="button"
            accessibilityLabel={`Destaque da casa: ${pizza.name}, a partir de ${formatCents(pizza.fromCents)}`}
            accessibilityHint="Abre a montagem da pizza"
            onPress={() => onOpenPizza(pizza.id)}
            style={({ pressed }) => ({
              width,
              opacity: pressed ? 0.92 : 1,
            })}
          >
            <View
              style={{
                height: Math.round(width * 0.62),
                borderRadius: theme.radius.xl,
                overflow: "hidden",
                backgroundColor: theme.colors.primaryLight,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {pizza.imageId ? (
                <Image
                  source={{ uri: imageUrl(pizza.imageId) }}
                  accessible={false}
                  accessibilityIgnoresInvertColors
                  resizeMode="cover"
                  style={{ width: "100%", height: "100%" }}
                />
              ) : (
                <Icon
                  name="pizza-outline"
                  size={96}
                  color={theme.colors.accentText}
                />
              )}
            </View>
            {/* Text on an opaque card, not over the photo: it keeps contrast and grows freely. */}
            <View
              style={{
                marginTop: -theme.spacing(7),
                marginHorizontal: theme.spacing(3),
                padding: theme.spacing(4),
                borderRadius: theme.radius.large,
                backgroundColor: theme.colors.primary,
                flexDirection: "row",
                alignItems: "center",
                gap: theme.spacing(3),
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  style={{
                    color: theme.colors.onPrimary,
                    ...theme.typography.caption,
                    fontWeight: "800",
                    letterSpacing: 0.4,
                  }}
                >
                  DESTAQUE DA CASA
                </Text>
                <Text
                  numberOfLines={2}
                  style={{
                    color: theme.colors.onPrimary,
                    ...theme.typography.title,
                    fontWeight: "800",
                  }}
                >
                  {pizza.name}
                </Text>
                <Text
                  style={{
                    color: theme.colors.onPrimary,
                    ...theme.typography.bodySmall,
                    fontWeight: "600",
                  }}
                >
                  a partir de {formatCents(pizza.fromCents)}
                </Text>
              </View>
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: theme.colors.surface,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon
                  name="arrow-forward"
                  size={22}
                  color={theme.colors.accentText}
                />
              </View>
            </View>
          </Pressable>
        ))}
      </ScrollView>
      {pizzas.length > 1 ? (
        <View style={{ flexDirection: "row", justifyContent: "center" }}>
          {pizzas.map((pizza, index) => (
            <Pressable
              key={pizza.id}
              accessibilityRole="button"
              accessibilityLabel={`Mostrar destaque ${index + 1} de ${pizzas.length}`}
              accessibilityState={{ selected: page === index }}
              onPress={() => {
                setPage(index);
                list.current?.scrollTo({
                  x: index * width,
                  animated: !reduceMotion,
                });
              }}
              style={{
                width: 28,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <View
                style={{
                  width: page === index ? 20 : 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor:
                    page === index ? theme.colors.primary : theme.colors.border,
                }}
              />
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function HighlightCard({
  pizza,
  imageUrl,
  onPress,
}: {
  pizza: PizzaItem;
  imageUrl: string | null;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${pizza.name}, a partir de ${formatCents(pizza.fromCents)}`}
      accessibilityHint="Abre a montagem da pizza"
      onPress={onPress}
      style={({ pressed }) => [
        {
          width: 156,
          padding: theme.spacing(3),
          gap: theme.spacing(2),
          borderRadius: theme.radius.xl,
          backgroundColor: theme.colors.surface,
          opacity: pressed ? 0.85 : 1,
        },
        theme.shadow,
      ]}
    >
      <View style={{ alignItems: "center" }}>
        <ItemPhoto item={pizza} imageUrl={imageUrl} size={110} />
      </View>
      <Text
        numberOfLines={2}
        style={{
          color: theme.colors.text,
          ...theme.typography.body,
          fontWeight: "700",
        }}
      >
        {pizza.name}
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: theme.spacing(1),
        }}
      >
        <Text
          style={{
            flexShrink: 1,
            color: theme.colors.text,
            ...theme.typography.bodySmall,
            fontWeight: "800",
          }}
        >
          {formatCents(pizza.fromCents)}
        </Text>
        <PlusMark />
      </View>
    </Pressable>
  );
}
