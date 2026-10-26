import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";
import type { StoreMessage } from "./store-messages.ts";

interface Props {
  message: StoreMessage;
  refreshing: boolean;
  onRetry: () => void;
}

/**
 * First screen of the app (M5.1): the store with its brand, or the closed or unavailable notice.
 * The menu arrives in M5.2. Text scales with the system font size; touch targets are 48 dp.
 */
export function StoreScreen({ message, refreshing, onRetry }: Props) {
  const theme = useTheme();
  const notice = message.screen !== "store";
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.cream }}
      contentContainerStyle={[styles.content, { padding: theme.spacing(5) }]}
    >
      {message.notice ? (
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
          <Text style={[styles.body, { color: theme.colors.text }]}>
            {message.notice}
          </Text>
        </View>
      ) : null}
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radius.card,
            padding: theme.spacing(5),
            gap: theme.spacing(3),
          },
        ]}
      >
        <Text
          accessibilityRole="header"
          style={[
            styles.title,
            { color: notice ? theme.colors.text : theme.colors.accentText },
          ]}
        >
          {message.title}
        </Text>
        <Text style={[styles.body, { color: theme.colors.text }]}>
          {message.body}
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
          <Text style={[styles.buttonText, { color: theme.colors.onPrimary }]}>
            {refreshing ? "Atualizando…" : "Atualizar"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: "center", gap: 16 },
  banner: { borderWidth: 1 },
  card: {
    shadowColor: "#252525",
    shadowOpacity: 0.07,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 28,
    elevation: 3,
  },
  title: { fontSize: 32, fontWeight: "800", lineHeight: 36 },
  body: { fontSize: 16, lineHeight: 26 },
  button: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  buttonText: { fontSize: 16, fontWeight: "700" },
});
