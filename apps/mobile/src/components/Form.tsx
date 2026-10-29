import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { useTheme } from "../brand/theme.tsx";
export function Body({
  children,
  alert = false,
}: {
  children: ReactNode;
  alert?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole={alert ? "alert" : undefined}
      accessibilityLiveRegion={alert ? "polite" : undefined}
      style={{
        color: alert ? colors.error : colors.text,
        fontSize: 16,
        lineHeight: 24,
      }}
    >
      {children}
    </Text>
  );
}
export function Heading({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ color: colors.accentText, fontSize: 24, fontWeight: "800" }}
    >
      {children}
    </Text>
  );
}
export function Button({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: theme.radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed
          ? theme.colors.primaryPressed
          : theme.colors.primary,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text
        style={{
          color: theme.colors.onPrimary,
          fontSize: 16,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Body>{label}</Body>
      <TextInput
        {...props}
        accessibilityLabel={label}
        style={{
          color: theme.colors.text,
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: 1,
          borderRadius: theme.radius.small,
          padding: 12,
          minHeight: 48,
          fontSize: 16,
        }}
      />
    </View>
  );
}
export function FormPage({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.cream }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 16, gap: 16 }}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
