import Constants from "expo-constants";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { fileBrandCache } from "./src/brand/file-cache.ts";
import {
  type StoreView,
  cachedBrand,
  loadStore,
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
  const cache = useMemo(
    () => (runtime ? fileBrandCache(runtime.storeSlug) : null),
    [],
  );

  const refresh = useCallback(async () => {
    if (!runtime || !cache) return;
    setRefreshing(true);
    try {
      setView(
        await loadStore({
          apiUrl: runtime.apiUrl,
          storeSlug: runtime.storeSlug,
          fallback: { name: runtime.storeName, colors: runtime.fallbackColors },
          cache,
          fetch,
        }),
      );
    } finally {
      setRefreshing(false);
    }
  }, [cache]);

  useEffect(() => {
    // The cached brand paints the first frame; the API answer replaces it when it arrives.
    if (runtime && cache)
      void cachedBrand(cache, runtime.storeSlug).then(setCached);
    void refresh();
  }, [cache, refresh]);

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
