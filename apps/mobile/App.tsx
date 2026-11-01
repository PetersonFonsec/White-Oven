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
  type Destination,
  buildingAfterRefresh,
  createMenuLoader,
  destinationAfterSignIn,
  destinationOnBack,
  opensAddressForm,
  returnLabel,
  destinationAfterRefresh,
  destinationKind,
  screenFor,
} from "./src/navigation/app-state.ts";
import { BuilderScreen } from "./src/screens/BuilderScreen.tsx";
import { type MenuLoad, MenuScreen } from "./src/screens/MenuScreen.tsx";
import { StoreScreen } from "./src/screens/StoreScreen.tsx";
import { menuNotices, storeMessage } from "./src/screens/store-messages.ts";

import { addPizza, addProduct, cartUnits } from "./src/cart/cart.ts";

import {
  nativeCommerce,
  nativeInstallationId,
  randomUUID,
} from "./src/customer/native.ts";
import {
  type PushModel,
  createNotificationRouter,
  createPushModel,
} from "./src/customer/push.ts";
import {
  nativePush,
  onNotificationOpened,
} from "./src/customer/push-native.ts";
import type { CommerceModel, CommerceState } from "./src/cart/model.ts";
import {
  type CheckoutSettings,
  parseCheckoutSettings,
} from "./src/cart/summary.ts";
import { AccountScreen } from "./src/screens/AccountScreen.tsx";
import { type LegalState, loadStoreLegal } from "./src/customer/legal.ts";
import {
  type CheckoutDraft,
  CheckoutScreen,
  EMPTY_DRAFT,
} from "./src/screens/CheckoutScreen.tsx";
import { OrdersScreen } from "./src/screens/OrdersScreen.tsx";
import { Button } from "./src/components/Form.tsx";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { InlineMessage, ToastProvider } from "./src/components/Feedback.tsx";
import { TabBarContext } from "./src/components/Screen.tsx";
import {
  BottomNavigation,
  type MainTab,
} from "./src/components/BottomNavigation.tsx";

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
  const [destination, setDestination] = useState<Destination>(null);
  const destinationRef = useRef<Destination>(null);
  destinationRef.current = destination;
  const [orderReturn, setOrderReturn] = useState<"history" | "cart">("history");
  // The bag's form outlives the bag screen (sign-in, new address); a new order starts it over.
  const [checkoutDraft, setCheckoutDraft] =
    useState<CheckoutDraft>(EMPTY_DRAFT);
  const receiptId = commerce?.receipt?.id ?? null;
  useEffect(() => {
    if (receiptId) setCheckoutDraft(EMPTY_DRAFT);
  }, [receiptId]);
  const navigate = (next: Destination) => {
    commerceRef.current?.invalidateQuote();
    setDestination(next);
  };
  const push = useMemo<PushModel | null>(
    () =>
      model && runtime
        ? createPushModel({
            api: model.push,
            native: nativePush(runtime.pushProjectId),
            installation: () =>
              nativeInstallationId(runtime.apiUrl, runtime.storeSlug),
          })
        : null,
    [model],
  );
  // The store's terms and privacy policy (ADR 0030): read again each time the account opens, so
  // sign-up always shows (and sends) the versions the API holds now.
  const [legal, setLegal] = useState<LegalState>({ status: "loading" });
  const legalRequest = useRef(0);
  const reloadLegal = useCallback(async (): Promise<LegalState> => {
    if (!runtime) return { status: "error" };
    const request = ++legalRequest.current;
    setLegal({ status: "loading" });
    const next = await loadStoreLegal({
      apiUrl: runtime.apiUrl,
      storeSlug: runtime.storeSlug,
      fetch,
    });
    if (request === legalRequest.current) setLegal(next);
    return next;
  }, []);
  const accountOpen = destinationKind(destination) === "account";
  useEffect(() => {
    if (accountOpen) void reloadLegal();
  }, [accountOpen, reloadLegal]);
  const profileId = commerce?.profile?.id ?? null;
  // A sign-in from the bag or the orders goes back there (UX audit P1-3).
  const signedInBefore = useRef(profileId);
  useEffect(() => {
    const wasSignedIn = signedInBefore.current;
    signedInBefore.current = profileId;
    if (wasSignedIn || !profileId) return;
    const back = destinationAfterSignIn(destinationRef.current);
    if (back) setDestination(back);
  }, [profileId]);
  const sessionStatus = commerce?.session ?? "idle";
  // The device's opt-in belongs to the signed-in session; another account starts from its own.
  useEffect(() => {
    if (!push) return;
    push.reset();
    if (profileId) void push.refresh();
  }, [push, profileId]);
  // A tapped order notification opens that order once the session is known (ADR 0027).
  const notifications = useRef(createNotificationRouter());
  const [notificationTap, setNotificationTap] = useState(0);
  const [notificationNotice, setNotificationNotice] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!runtime?.pushProjectId) return;
    return onNotificationOpened((notificationId, data) => {
      if (notifications.current.opened(notificationId, data))
        setNotificationTap((count) => count + 1);
    });
  }, []);
  useEffect(() => {
    const route = notifications.current.take({
      status: sessionStatus,
      signedIn: profileId !== null,
    });
    if (route.kind === "order") {
      setNotificationNotice(null);
      setOrderReturn("history");
      navigate({ kind: "order", orderId: route.orderId });
    } else if (route.kind === "login") {
      setNotificationNotice(
        "Entre na conta que fez o pedido para acompanhá-lo.",
      );
      navigate({ kind: "account" });
    }
  }, [notificationTap, sessionStatus, profileId]);
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
  const [tabBarHeight, setTabBarHeight] = useState(0);
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
  // Android's back button goes up one level: builder to menu, an order to where it was opened,
  // an account opened from the bag back to the bag, any tab back to the menu.
  useEffect(() => {
    if (!inBuilder && !destination) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (commerceRef.current?.getSnapshot().busy) return true;
        commerceRef.current?.invalidateQuote();
        if (inBuilder) setBuilding(null);
        else setDestination(destinationOnBack(destination, orderReturn));
        return true;
      },
    );
    return () => subscription.remove();
  }, [inBuilder, destination, orderReturn]);

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
  const activeTab: MainTab | null =
    screen.kind === "menu"
      ? "menu"
      : screen.kind === "cart"
        ? "cart"
        : screen.kind === "history" || screen.kind === "order"
          ? "orders"
          : screen.kind === "account"
            ? "profile"
            : null;

  if (!runtime)
    return (
      <View style={styles.center}>
        <Text accessibilityRole="alert">
          Este aplicativo foi gerado sem a configuração da pizzaria.
        </Text>
      </View>
    );

  const logoUrl = view?.logoImageId
    ? imageUrl(runtime.apiUrl, runtime.storeSlug, view.logoImageId, "thumbnail")
    : null;
  const theme = themeFor(
    view?.colors ?? cached?.colors ?? runtime.fallbackColors,
  );
  return (
    <SafeAreaProvider>
      <ThemeProvider value={theme}>
        <StatusBar style="dark" />
        <TabBarContext.Provider value={activeTab !== null}>
          <ToastProvider bottomOffset={activeTab ? tabBarHeight : 0}>
            <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
              {(screen.kind === "history" || screen.kind === "order") &&
              model &&
              commerce ? (
                <OrdersScreen
                  model={model}
                  state={commerce}
                  menu={menuData}
                  menuStale={menuStale}
                  storeUnavailable={view?.availability.kind === "unavailable"}
                  orderId={screen.kind === "order" ? screen.orderId : null}
                  onBack={() =>
                    screen.kind === "order"
                      ? navigate({ kind: orderReturn })
                      : navigate(null)
                  }
                  backTo={orderReturn === "cart" ? "Sacola" : "Pedidos"}
                  onAccount={() =>
                    navigate({ kind: "account", returnTo: "history" })
                  }
                  onOpenOrder={(orderId) => {
                    setOrderReturn("history");
                    navigate({ kind: "order", orderId });
                  }}
                  onOpenCart={() => navigate({ kind: "cart" })}
                  onOpenMenu={() => navigate(null)}
                />
              ) : screen.kind === "account" && model && commerce && push ? (
                <AccountScreen
                  key={`${commerce.profile?.id ?? "signed-out"}:${opensAddressForm(destination)}`}
                  model={model}
                  state={commerce}
                  push={push}
                  notice={commerce.profile ? null : notificationNotice}
                  legal={legal}
                  storeName={view?.name ?? cached?.name ?? runtime.storeName}
                  logoUrl={logoUrl}
                  backTo={returnLabel(destination)}
                  startWithAddress={opensAddressForm(destination)}
                  onReloadLegal={reloadLegal}
                  onBack={() => {
                    const back = destinationAfterSignIn(destination);
                    navigate(back);
                  }}
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
                  draft={checkoutDraft}
                  onDraft={setCheckoutDraft}
                  onBack={() => navigate(null)}
                  onAccount={() =>
                    navigate({ kind: "account", returnTo: "cart" })
                  }
                  onAddAddress={() =>
                    navigate({
                      kind: "account",
                      returnTo: "cart",
                      startWith: "address",
                    })
                  }
                  onTrackOrder={(orderId) => {
                    setOrderReturn("cart");
                    navigate({ kind: "order", orderId });
                  }}
                  onRefresh={() => void refresh()}
                />
              ) : view && screen.kind === "builder" && builder ? (
                <BuilderScreen
                  key={screen.flavorId}
                  builder={builder}
                  flavorId={screen.flavorId}
                  flavorImageUrl={(id) =>
                    imageUrl(runtime.apiUrl, runtime.storeSlug, id, "thumbnail")
                  }
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
                                builder.menu.flavors.find((f) => f.id === id)
                                  ?.name ?? "Pizza",
                            )
                            .join(" / "),
                          pizza,
                        }),
                      )
                      .then((saved) => {
                        if (saved) {
                          setBuilding(null);
                          setDestination({ kind: "cart" });
                        }
                      });
                  }}
                />
              ) : view && screen.kind === "menu" ? (
                <MenuScreen
                  addingDisabled={
                    !commerce?.ready || commerce.busy || !!commerce.pending
                  }
                  onAddProduct={async (id) => {
                    const product = menuData?.simpleProducts.find(
                      (p) => p.id === id,
                    );
                    if (!product || !model) return null;
                    const saved = await model.changeCart((lines) =>
                      addProduct(lines, {
                        id: randomUUID(),
                        productId: id,
                        name: product.name,
                      }),
                    );
                    return saved ? product.name : null;
                  }}
                  onOpenCart={() => navigate({ kind: "cart" })}
                  banner={
                    <>
                      {bootError ? (
                        <InlineMessage
                          tone="error"
                          title="Sacola indisponível"
                          action={
                            <Button
                              label="Tentar de novo"
                              size="small"
                              onPress={() => setBootNonce((value) => value + 1)}
                            />
                          }
                        >
                          {bootError}
                        </InlineMessage>
                      ) : null}
                      {commerce?.error ? (
                        <InlineMessage tone="error">
                          {commerce.error}
                        </InlineMessage>
                      ) : null}
                      {commerce?.pending ? (
                        <InlineMessage
                          tone="warning"
                          title="Pedido aguardando confirmação"
                          action={
                            <Button
                              label="Ver na sacola"
                              size="small"
                              disabled={commerce.busy}
                              onPress={() => navigate({ kind: "cart" })}
                            />
                          }
                        >
                          Confira o resultado antes de fazer outro pedido.
                        </InlineMessage>
                      ) : null}
                    </>
                  }
                  openStatus={
                    view.availability.kind === "open"
                      ? "open"
                      : view.availability.kind === "closed"
                        ? "closed"
                        : null
                  }
                  storeName={view.name}
                  notices={menuNotices(view, menuStale)}
                  logoUrl={logoUrl}
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
                <StoreScreen
                  message={storeMessage(view)}
                  refreshing={refreshing}
                  onRetry={() => void refresh()}
                  actions={
                    <>
                      {commerce?.pending ? (
                        <Button
                          label="Recuperar pedido pendente"
                          variant="primary"
                          disabled={commerce.busy}
                          onPress={() => navigate({ kind: "cart" })}
                        />
                      ) : null}
                      <Button
                        label="Meus pedidos"
                        icon="receipt-outline"
                        variant="secondary"
                        disabled={!commerce || commerce.busy}
                        onPress={() => navigate({ kind: "history" })}
                      />
                      <Button
                        label="Minha conta"
                        icon="person-circle-outline"
                        variant="secondary"
                        disabled={!commerce || commerce.busy}
                        onPress={() => navigate({ kind: "account" })}
                      />
                    </>
                  }
                />
              ) : (
                <View
                  style={[
                    styles.center,
                    { backgroundColor: theme.colors.cream },
                  ]}
                >
                  <ActivityIndicator
                    accessibilityLabel={`Abrindo ${cached?.name ?? runtime.storeName}`}
                    color={theme.colors.accentText}
                    size="large"
                  />
                </View>
              )}
              {activeTab ? (
                <BottomNavigation
                  selected={activeTab}
                  cartCount={commerce ? cartUnits(commerce.cart) : 0}
                  onHeight={setTabBarHeight}
                  onSelect={(tab) => {
                    if (tab === "menu") navigate(null);
                    else if (tab === "cart") navigate({ kind: "cart" });
                    else if (tab === "orders") navigate({ kind: "history" });
                    else navigate({ kind: "account" });
                  }}
                />
              ) : null}
            </View>
          </ToastProvider>
        </TabBarContext.Provider>
      </ThemeProvider>
    </SafeAreaProvider>
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
