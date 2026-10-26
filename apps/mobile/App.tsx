import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
} from "./src/brand/store-loader.ts";
import { ThemeProvider, themeFor } from "./src/brand/theme.tsx";
import { parseRuntimeConfig } from "./src/config/manifest.ts";
import { builderMenu } from "./src/builder/builder.ts";
import {
  type PublicMenu,
  imageUrl,
  loadMenu,
  menuSections,
} from "./src/menu/menu.ts";
import { BuilderScreen } from "./src/screens/BuilderScreen.tsx";
import { type MenuLoad, MenuScreen } from "./src/screens/MenuScreen.tsx";
import { StoreScreen } from "./src/screens/StoreScreen.tsx";
import { menuNotices, storeMessage } from "./src/screens/store-messages.ts";

const runtime = parseRuntimeConfig(Constants.expoConfig?.extra);

/**
 * The white label app of one store (M5.1, ADR 0020; menu and builder M5.2, ADR 0021). The build
 * embeds only the store slug, the API address and fallback colors from the manifest; name, brand,
 * status and menu come from the API, and the last brand is kept to open offline.
 */
export default function App() {
  const [view, setView] = useState<StoreView | null>(null);
  const [cached, setCached] = useState<Awaited<
    ReturnType<typeof cachedBrand>
  > | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresher = useRef<StoreRefresher | null>(null);
  const [menu, setMenu] = useState<
    { kind: "loading" } | { kind: "ok"; menu: PublicMenu } | { kind: "failed" }
  >({ kind: "loading" });
  /** The pizza open in the builder; null shows the menu. */
  const [building, setBuilding] = useState<string | null>(null);
  const menuLoad = useRef<AbortController | null>(null);

  /** The menu once at a time: a new load aborts the one before, whose answer is dropped. */
  const reloadMenu = useCallback(async () => {
    if (!runtime) return;
    menuLoad.current?.abort();
    const controller = new AbortController();
    menuLoad.current = controller;
    setMenu((current) =>
      current.kind === "ok" ? current : { kind: "loading" },
    );
    const answer = await loadMenu({
      apiUrl: runtime.apiUrl,
      storeSlug: runtime.storeSlug,
      fetch,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    setMenu((current) =>
      answer.kind === "ok"
        ? { kind: "ok", menu: answer.body }
        : // A menu already on screen stays when a later reload fails.
          current.kind === "ok"
          ? current
          : { kind: "failed" },
    );
  }, []);

  /**
   * One load at a time (ADR 0020): a tap while a load runs joins it. The refresher of an
   * unmounted screen is disposed, so its answer neither reaches the state nor the cache.
   */
  const refresh = useCallback(async () => {
    const current = refresher.current;
    if (!current) return;
    setRefreshing(true);
    void reloadMenu();
    const next = await current.refresh();
    if (refresher.current !== current) return;
    if (next) setView(next);
    setRefreshing(current.refreshing);
  }, [reloadMenu]);

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
    // The cached brand paints the first frame; the API answer replaces it when it arrives.
    void cachedBrand(cache, runtime.storeSlug).then((brand) => {
      if (refresher.current === current) setCached(brand);
    });
    void refresh();
    return () => {
      refresher.current = null;
      current.dispose();
      menuLoad.current?.abort();
    };
  }, [refresh]);

  // Android's back button leaves the builder for the menu.
  useEffect(() => {
    if (!building) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        setBuilding(null);
        return true;
      },
    );
    return () => subscription.remove();
  }, [building]);

  const builder = useMemo(
    () => (menu.kind === "ok" ? builderMenu(menu.menu) : null),
    [menu],
  );
  const menuScreenLoad = useMemo(() => menuView(menu), [menu]);

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
      {view && builder && building ? (
        <BuilderScreen
          key={building}
          builder={builder}
          flavorId={building}
          onBack={() => setBuilding(null)}
        />
      ) : view && view.availability.kind !== "unavailable" ? (
        <MenuScreen
          storeName={view.name}
          notices={menuNotices(view)}
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
          menu={menuScreenLoad}
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
        />
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

function menuView(
  menu:
    { kind: "loading" } | { kind: "ok"; menu: PublicMenu } | { kind: "failed" },
): MenuLoad {
  return menu.kind === "ok"
    ? { kind: "ok", sections: menuSections(menu.menu) }
    : menu;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
});
