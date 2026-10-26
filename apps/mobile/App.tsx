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
import { imageUrl, loadMenu, menuSections } from "./src/menu/menu.ts";
import {
  type MenuLoader,
  type MenuState,
  buildingAfterRefresh,
  createMenuLoader,
  screenFor,
} from "./src/navigation/app-state.ts";
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
    if (!current) return;
    setRefreshing(true);
    void menuLoader.current?.reload();
    const next = await current.refresh();
    if (refresher.current !== current) return;
    if (next) {
      setView(next);
      // A store confirmed unavailable closes the builder for good (ADR 0021).
      setBuilding((open) => buildingAfterRefresh(open, next));
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
      refresher.current = null;
      current.dispose();
      menuLoader.current = null;
      loader.dispose();
    };
  }, [refresh]);

  const screen = screenFor(view, menu, building);
  const inBuilder = screen.kind === "builder";
  // Android's back button leaves the builder for the menu.
  useEffect(() => {
    if (!inBuilder) return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        setBuilding(null);
        return true;
      },
    );
    return () => subscription.remove();
  }, [inBuilder]);

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
      {view && screen.kind === "builder" && builder ? (
        <BuilderScreen
          key={screen.flavorId}
          builder={builder}
          flavorId={screen.flavorId}
          menuStale={menuStale}
          onBack={() => setBuilding(null)}
        />
      ) : view && screen.kind === "menu" ? (
        <MenuScreen
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

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
});
