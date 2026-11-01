import { useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { useTheme } from "../brand/theme.tsx";

export function Body({
  children,
  alert = false,
  small = false,
  muted = false,
  centered = false,
}: {
  children: ReactNode;
  alert?: boolean;
  small?: boolean;
  muted?: boolean;
  centered?: boolean;
}) {
  const { colors, typography } = useTheme();
  const type = small ? typography.bodySmall : typography.body;
  return (
    <Text
      accessibilityRole={alert ? "alert" : undefined}
      accessibilityLiveRegion={alert ? "polite" : undefined}
      style={{
        color: alert
          ? colors.error
          : muted
            ? colors.textSecondary
            : colors.text,
        fontSize: type.fontSize,
        lineHeight: type.lineHeight,
        textAlign: centered ? "center" : "left",
      }}
    >
      {children}
    </Text>
  );
}

export function Heading({
  children,
  level = "h2",
  centered = false,
}: {
  children: ReactNode;
  level?: "display" | "h1" | "h2" | "h3" | "title";
  centered?: boolean;
}) {
  const { colors, typography } = useTheme();
  const type = typography[level];
  return (
    <Text
      accessibilityRole="header"
      style={{
        color:
          level === "display" || level === "h1"
            ? colors.accentText
            : colors.text,
        fontSize: type.fontSize,
        fontWeight: type.fontWeight,
        lineHeight: type.lineHeight,
        textAlign: centered ? "center" : "left",
      }}
    >
      {children}
    </Text>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function Button({
  label,
  onPress,
  disabled = false,
  loading = false,
  variant = "secondary",
  size = "large",
  style,
  accessibilityHint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
  size?: "small" | "medium" | "large";
  style?: ViewStyle;
  accessibilityHint?: string;
}) {
  const { colors, typography, radius } = useTheme();
  const inactive = disabled || loading;
  const background =
    variant === "primary"
      ? colors.primary
      : variant === "destructive"
        ? colors.error
        : variant === "secondary"
          ? colors.surface
          : "transparent";
  const foreground =
    variant === "primary"
      ? colors.onPrimary
      : variant === "destructive"
        ? colors.surface
        : colors.accentText;
  const height = size === "small" ? 44 : size === "medium" ? 48 : 52;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      accessibilityState={{ busy: loading, disabled: inactive }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: height,
          minWidth: 44,
          paddingHorizontal: size === "small" ? 14 : 20,
          paddingVertical: 10,
          borderRadius: variant === "ghost" ? radius.medium : radius.large,
          alignItems: "center",
          justifyContent: "center",
          borderWidth: variant === "secondary" ? 1 : 0,
          borderColor: colors.border,
          backgroundColor:
            pressed && variant === "primary"
              ? colors.primaryPressed
              : pressed && variant === "secondary"
                ? colors.primaryLight
                : background,
          opacity: inactive ? 0.55 : 1,
        },
        style,
      ]}
    >
      <Text
        style={{
          color: foreground,
          fontSize: typography.button.fontSize,
          lineHeight: typography.button.lineHeight,
          fontWeight: typography.button.fontWeight,
          textAlign: "center",
        }}
      >
        {loading ? `${label}…` : label}
      </Text>
    </Pressable>
  );
}

export function Field({
  label,
  error,
  helper,
  ...props
}: TextInputProps & { label: string; error?: string; helper?: string }) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text
        style={{
          color: theme.colors.text,
          fontSize: theme.typography.bodySmall.fontSize,
          lineHeight: theme.typography.bodySmall.lineHeight,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
      <TextInput
        {...props}
        accessibilityLabel={label}
        accessibilityHint={helper}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        placeholderTextColor={theme.colors.textMuted}
        selectionColor={theme.colors.primary}
        style={[
          {
            color: theme.colors.text,
            backgroundColor: theme.colors.surface,
            borderColor: error
              ? theme.colors.error
              : focused
                ? theme.colors.primary
                : theme.colors.inputBorder,
            borderWidth: focused || error ? 1.5 : 1,
            borderRadius: theme.radius.medium,
            paddingHorizontal: 14,
            minHeight: 52,
            fontSize: theme.typography.body.fontSize,
          },
          props.style,
        ]}
      />
      {error ? (
        <Body alert small>
          {error}
        </Body>
      ) : helper ? (
        <Body small muted>
          {helper}
        </Body>
      ) : null}
    </View>
  );
}

export function SurfaceCard({
  children,
  tone = "surface",
  style,
}: {
  children: ReactNode;
  tone?: "surface" | "secondary" | "outlined";
  style?: ViewStyle;
}) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={[
        {
          padding: spacing(4),
          borderRadius: radius.large,
          backgroundColor:
            tone === "secondary"
              ? colors.surfaceSecondary
              : tone === "outlined"
                ? "transparent"
                : colors.surface,
          borderWidth: tone === "outlined" ? 1 : 0,
          borderColor: colors.border,
          gap: spacing(3),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Divider() {
  const { colors } = useTheme();
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}

export function FormPage({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: theme.spacing(5),
          paddingTop: theme.spacing(4),
          paddingBottom: theme.spacing(7),
          gap: theme.spacing(4),
        }}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
