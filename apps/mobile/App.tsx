import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { fileBrandCache } from "./src/brand/file-cache.ts";
import {
  type StoreRefresher,
  type StoreView,
  cachedBrand,
  createStoreRefresher,
} from "./src/brand/store-loader.ts";
import { ThemeProvider, themeFor } from "./src/brand/theme.tsx";
import { parseRuntimeConfig } from "./src/config/manifest.ts";
import { StoreScreen } from "./src/screens/StoreScreen.tsx";
import { storeMessage } from "./src/screens/store-messages.ts";

const runtime = parseRuntimeConfig(Constants.expoConfig?.extra);

/**
 * The white label app of one store (M5.1, ADR 0020). The build embeds only the store slug, the
 * API address and fallback colors from the manifest; name, brand and status come from the API,
 * and the last brand is kept to open offline.
 */
export default function App() {
  const [view, setView] = useState<StoreView | null>(null);
  const [cached, setCached] = useState<Awaited<
    ReturnType<typeof cachedBrand>
  > | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresher = useRef<StoreRefresher | null>(null);

  /**
   * One load at a time (ADR 0020): a tap while a load runs joins it. The refresher of an
   * unmounted screen is disposed, so its answer neither reaches the state nor the cache.
   */
  const refresh = useCallback(async () => {
    const current = refresher.current;
    if (!current) return;
    setRefreshing(true);
    const next = await current.refresh();
    if (refresher.current !== current) return;
    if (next) setView(next);
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
    // The cached brand paints the first frame; the API answer replaces it when it arrives.
    void cachedBrand(cache, runtime.storeSlug).then((brand) => {
      if (refresher.current === current) setCached(brand);
    });
    void refresh();
    return () => {
      refresher.current = null;
      current.dispose();
    };
  }, [refresh]);

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
      {view ? (
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
