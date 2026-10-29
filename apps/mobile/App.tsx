import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  ActivityIndicator,
  BackHandler,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { fileBrandCache } from "./src/brand/file-cache.ts";
import {
  type StoreRefresher,
  type StoreView,
  cachedBrand,
  createStoreRefresher,
  publicGet,
} from "./src/brand/store-loader.ts";
import { ThemeProvider, themeFor } from "./src/brand/theme.tsx";
import { parseRuntimeConfig } from "./src/config/manifest.ts";
import { builderMenu } from "./src/builder/builder.ts";
import { imageUrl, loadMenu, menuSections } from "./src/menu/menu.ts";
import {
  type MenuLoader,
  type MenuState,
  type Recovery,
  buildingAfterRefresh,
  createMenuLoader,
  destinationAfterRefresh,
  screenFor,
} from "./src/navigation/app-state.ts";
import { BuilderScreen } from "./src/screens/BuilderScreen.tsx";
import { type MenuLoad, MenuScreen } from "./src/screens/MenuScreen.tsx";
import { StoreScreen } from "./src/screens/StoreScreen.tsx";
import { menuNotices, storeMessage } from "./src/screens/store-messages.ts";

import { addPizza, addProduct } from "./src/cart/cart.ts";

import { nativeCommerce, randomUUID } from "./src/customer/native.ts";
import type { CommerceModel, CommerceState } from "./src/cart/model.ts";
import {
  type CheckoutSettings,
  parseCheckoutSettings,
} from "./src/cart/summary.ts";
import { AccountScreen } from "./src/screens/AccountScreen.tsx";
import { CheckoutScreen } from "./src/screens/CheckoutScreen.tsx";
import { Body, Button } from "./src/components/Form.tsx";

const runtime = parseRuntimeConfig(Constants.expoConfig?.extra);

let commercePromise: Promise<CommerceModel> | null = null;
function getCommerce() {
  if (!commercePromise)
    commercePromise = nativeCommerce(runtime!.apiUrl, runtime!.storeSlug).catch(
      (error) => {
        commercePromise = null;
        throw error;
      },
    );
  return commercePromise;
}

/**
 * The white label app of one store (M5.1, ADR 0020; menu and builder M5.2, ADR 0021). The build
 * embeds only the store slug, the API address and fallback colors from the manifest; name, brand,
 * status and menu come from the API, and the last brand is kept to open offline.
 */
export default function App() {
  const [model, setModel] = useState<CommerceModel | null>(null);
  const [commerce, setCommerce] = useState<CommerceState | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootNonce, setBootNonce] = useState(0);
  const [destination, setDestination] = useState<"account" | "cart" | null>(
    null,
  );
  const navigate = (next: "account" | "cart" | null) => {
    commerceRef.current?.invalidateQuote();
    setDestination(next);
  };
  const [checkoutSettings, setCheckoutSettings] =
    useState<CheckoutSettings | null>(null);
  const settingsRequest = useRef<AbortController | null>(null);
  const commerceRef = useRef<CommerceModel | null>(null);
  useEffect(() => {
    if (!runtime) return;
    let active = true;
    let unsubscribe: (() => void) | undefined;
    setBootError(null);
    getCommerce()
      .then((current) => {
        if (!active) return;
        commerceRef.current = current;
        setModel(current);
        setCommerce(current.getSnapshot());
        unsubscribe = current.subscribe(() =>
          setCommerce(current.getSnapshot()),
        );
        void current.init();
      })
      .catch(() => {
        if (active)
          setBootError(
            "Não foi possível abrir o armazenamento seguro do dispositivo.",
          );
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bootNonce]);
  const [view, setView] = useState<StoreView | null>(null);
  const [cached, setCached] = useState<Awaited<
    ReturnType<typeof cachedBrand>
  > | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresher = useRef<StoreRefresher | null>(null);
  const [menu, setMenu] = useState<MenuState>({ kind: "loading" });
  /** The pizza open in the builder; null shows the menu. */
  const [building, setBuilding] = useState<string | null>(null);
  const menuLoader = useRef<MenuLoader | null>(null);

  /**
   * One load at a time (ADR 0020): a tap while a load runs joins it. The refresher of an
   * unmounted screen is disposed, so its answer neither reaches the state nor the cache.
   */
  const refresh = useCallback(async () => {
    const current = refresher.current;
    if (!current || !runtime) return;
    commerceRef.current?.invalidateQuote();
    settingsRequest.current?.abort();
    const request = new AbortController();
    settingsRequest.current = request;
    setCheckoutSettings(null);
    const settings = publicGet(
      {
        apiUrl: runtime.apiUrl,
        storeSlug: runtime.storeSlug,
        fetch,
        signal: request.signal,
      },
      "",
      (raw) =>
        parseCheckoutSettings((raw as { checkout?: unknown } | null)?.checkout),
    );
    setRefreshing(true);
    void menuLoader.current?.reload();
    const [next, checkout] = await Promise.all([current.refresh(), settings]);
    if (refresher.current !== current || settingsRequest.current !== request)
      return;
    setCheckoutSettings(checkout.kind === "ok" ? checkout.body : null);
    if (next) {
      setView(next);
      // A store confirmed unavailable closes the builder for good (ADR 0021).
      setBuilding((open) => buildingAfterRefresh(open, next));
      const snapshot = commerceRef.current?.getSnapshot();
      setDestination((open) =>
        destinationAfterRefresh(
          open,
          next,
          snapshot ? recoveryOf(snapshot) : null,
        ),
      );
    }
    setRefreshing(current.refreshing);
  }, []);

  useEffect(() => {
    if (!runtime) return;
    const cache = fileBrandCache(runtime.storeSlug);
    const current = createStoreRefresher({
      apiUrl: runtime.apiUrl,
      storeSlug: runtime.storeSlug,
      fallback: { name: runtime.storeName, colors: runtime.fallbackColors },
      cache,
      fetch,
    });
    refresher.current = current;
    const loader = createMenuLoader(
      (signal) =>
        loadMenu({
          apiUrl: runtime.apiUrl,
          storeSlug: runtime.storeSlug,
          fetch,
          signal,
        }),
      setMenu,
    );
    menuLoader.current = loader;
    // The cached brand paints the first frame; the API answer replaces it when it arrives.
    void cachedBrand(cache, runtime.storeSlug).then((brand) => {
      if (refresher.current === current) setCached(brand);
    });
    void refresh();
    return () => {
      settingsRequest.current?.abort();
      refresher.current = null;
      current.dispose();
      menuLoader.current = null;
      loader.dispose();
    };
  }, [refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      if (status === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  useEffect(() => {
    model?.invalidateQuote();
  }, [model, menu]);
  const screen = screenFor(
    view,
    menu,
    building,
    destination,
    commerce ? recoveryOf(commerce) : null,
  );
  const inBuilder = screen.kind === "builder";
  // Android's back button leaves the builder for the menu.
  useEffect(() => {
    if (!inBuilder && !destination) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (commerceRef.current?.getSnapshot().busy) return true;
        commerceRef.current?.invalidateQuote();
        setBuilding(null);
        setDestination(null);
        return true;
      },
    );
    return () => subscription.remove();
  }, [inBuilder, destination]);

  // Keyed on the menu itself, so marking it stale does not rebuild the index or the sections.
  const menuData = menu.kind === "ok" ? menu.menu : null;
  const builder = useMemo(
    () => (menuData ? builderMenu(menuData) : null),
    [menuData],
  );
  const sections = useMemo(
    () => (menuData ? menuSections(menuData) : null),
    [menuData],
  );
  const menuStale = menu.kind === "ok" && menu.stale;
  const menuLoad: MenuLoad = sections
    ? { kind: "ok", sections }
    : { kind: menu.kind === "failed" ? "failed" : "loading" };

  if (!runtime)
    return (
      <View style={styles.center}>
        <Text accessibilityRole="alert">
          Este aplicativo foi gerado sem a configuração da pizzaria.
        </Text>
      </View>
    );

  const theme = themeFor(
    view?.colors ?? cached?.colors ?? runtime.fallbackColors,
  );
  return (
    <ThemeProvider value={theme}>
      <StatusBar style="dark" />
      {screen.kind === "account" && model && commerce ? (
        <AccountScreen
          key={commerce.profile?.id ?? "signed-out"}
          model={model}
          state={commerce}
          policy={runtime.privacyPolicy}
          onBack={() => navigate(null)}
        />
      ) : screen.kind === "cart" && model && commerce ? (
        <CheckoutScreen
          key={commerce.profile?.id ?? "signed-out"}
          model={model}
          state={commerce}
          menu={menuData}
          settings={checkoutSettings}
          canOrder={view?.availability.kind === "open" && !refreshing}
          recoveryOnly={screen.recoveryOnly}
          stale={menuStale}
          onBack={() => navigate(null)}
          onAccount={() => navigate("account")}
          onRefresh={() => void refresh()}
        />
      ) : view && screen.kind === "builder" && builder ? (
        <BuilderScreen
          key={screen.flavorId}
          builder={builder}
          flavorId={screen.flavorId}
          menuStale={menuStale}
          onBack={() => setBuilding(null)}
          addingDisabled={
            !commerce?.ready || commerce.busy || !!commerce.pending
          }
          addError={commerce?.error ?? null}
          onAdd={(pizza) => {
            if (!model) return;
            void model
              .changeCart((lines) =>
                addPizza(lines, {
                  id: randomUUID(),
                  kind: "PIZZA",
                  name: Object.values(pizza.flavors)
                    .map(
                      (id) =>
                        builder.menu.flavors.find((f) => f.id === id)?.name ??
                        "Pizza",
                    )
                    .join(" / "),
                  pizza,
                }),
              )
              .then((saved) => {
                if (saved) {
                  setBuilding(null);
                  setDestination("cart");
                }
              });
          }}
        />
      ) : view && screen.kind === "menu" ? (
        <MenuScreen
          addingDisabled={
            !commerce?.ready || commerce.busy || !!commerce.pending
          }
          onAddProduct={(id) => {
            const product = menuData?.simpleProducts.find((p) => p.id === id);
            if (product && model)
              void model.changeCart((lines) =>
                addProduct(lines, {
                  id: randomUUID(),
                  productId: id,
                  name: product.name,
                }),
              );
          }}
          cart={
            <View style={{ gap: 12 }}>
              {bootError ? (
                <>
                  <Body alert>{bootError}</Body>
                  <Button
                    label="Tentar novamente"
                    onPress={() => setBootNonce((value) => value + 1)}
                  />
                </>
              ) : null}
              {commerce?.error ? <Body alert>{commerce.error}</Body> : null}
              <Button
                label={`Carrinho (${commerce?.cart.length ?? 0})${commerce?.pending ? " · confirmação pendente" : ""}`}
                disabled={!commerce || commerce.busy}
                onPress={() => navigate("cart")}
              />
              <Button
                label="Minha conta"
                disabled={!commerce || commerce.busy}
                onPress={() => navigate("account")}
              />
            </View>
          }
          storeName={view.name}
          notices={menuNotices(view, menuStale)}
          logoUrl={
            view.logoImageId
              ? imageUrl(
                  runtime.apiUrl,
                  runtime.storeSlug,
                  view.logoImageId,
                  "thumbnail",
                )
              : null
          }
          menu={menuLoad}
          menuStale={menuStale}
          refreshing={refreshing}
          imageUrl={(id) =>
            imageUrl(runtime.apiUrl, runtime.storeSlug, id, "thumbnail")
          }
          onRetry={() => void refresh()}
          onOpenPizza={setBuilding}
        />
      ) : view ? (
        <View style={{ flex: 1 }}>
          <Button
            label="Minha conta"
            disabled={!commerce || commerce.busy}
            onPress={() => navigate("account")}
          />
          {commerce?.pending ? (
            <Button
              label="Recuperar pedido pendente"
              disabled={commerce.busy}
              onPress={() => navigate("cart")}
            />
          ) : null}
          <StoreScreen
            message={storeMessage(view)}
            refreshing={refreshing}
            onRetry={() => void refresh()}
          />
        </View>
      ) : (
        <View style={[styles.center, { backgroundColor: theme.colors.cream }]}>
          <ActivityIndicator
            accessibilityLabel={`Abrindo ${cached?.name ?? runtime.storeName}`}
            color={theme.colors.accentText}
            size="large"
          />
        </View>
      )}
    </ThemeProvider>
  );
}

/** Only a pending confirmation opens the cart of an unavailable store; its receipt keeps it open. */
function recoveryOf(state: CommerceState): Recovery {
  if (state.pending) return "pending";
  return state.receipt ? "receipt" : null;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
});
