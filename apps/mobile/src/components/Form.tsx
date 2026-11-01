import { useState, type ComponentRef, type ReactNode, type Ref } from "react";
import {
  ActivityIndicator,
  InputAccessoryView,
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { useAnnouncement } from "../a11y/useAnnouncement.ts";
import { useTheme } from "../brand/theme.tsx";
import { Icon, IconButton, type IconName } from "./Icon.tsx";
import { Screen } from "./Screen.tsx";

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
  // iOS reads neither the live region nor the alert role by itself.
  useAnnouncement(
    alert && typeof children === "string" ? children : null,
    alert,
  );
  return (
    <Text
      accessibilityRole={alert ? "alert" : undefined}
      accessibilityLiveRegion={alert ? "polite" : undefined}
      style={{
        color: alert
          ? colors.errorText
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
  accessibilityLabel,
  icon,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
  size?: "small" | "medium" | "large";
  style?: ViewStyle;
  accessibilityHint?: string;
  /** Read instead of the label when the label needs context (which item it changes). */
  accessibilityLabel?: string;
  icon?: IconName;
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
      accessibilityLabel={accessibilityLabel ?? label}
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
          flexDirection: "row",
          gap: 8,
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
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : icon ? (
        <Icon name={icon} size={20} color={foreground} />
      ) : null}
      <Text
        style={{
          color: foreground,
          fontSize: typography.button.fontSize,
          lineHeight: typography.button.lineHeight,
          fontWeight: typography.button.fontWeight,
          textAlign: "center",
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A labelled text field. The error replaces the helper under the field, is read with the field
 * (as its hint) and announced when it appears. `password` adds a show/hide button inside the
 * field. With `returnKeyType="next"`, the keyboard stays open while `onSubmitEditing` moves on.
 */
export function Field({
  label,
  error,
  helper,
  password = false,
  doneBar = false,
  ref,
  ...props
}: TextInputProps & {
  label: string;
  error?: string | null;
  helper?: string;
  password?: boolean;
  /** iOS number pads have no return key: a bar with "OK" over the keyboard closes it. */
  doneBar?: boolean;
  ref?: Ref<ComponentRef<typeof TextInput>>;
}) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  useAnnouncement(error ? `${label}: ${error}` : null);
  const accessoryId =
    doneBar && Platform.OS === "ios" ? `done-${label}` : undefined;
  const borderColor = error
    ? theme.colors.error
    : focused
      ? theme.colors.primary
      : theme.colors.inputBorder;
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
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor:
            props.editable === false
              ? theme.colors.surfaceSecondary
              : theme.colors.surface,
          borderColor,
          borderWidth: focused || error ? 2 : 1,
          borderRadius: theme.radius.medium,
        }}
      >
        <TextInput
          {...props}
          ref={ref}
          inputAccessoryViewID={accessoryId}
          accessibilityLabel={label}
          accessibilityHint={error ?? helper}
          secureTextEntry={password ? !visible : props.secureTextEntry}
          submitBehavior={
            props.returnKeyType === "next" ? "submit" : props.submitBehavior
          }
          onFocus={(event) => {
            setFocused(true);
            props.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            props.onBlur?.(event);
          }}
          placeholderTextColor={theme.colors.placeholder}
          selectionColor={theme.colors.primary}
          style={[
            {
              flex: 1,
              color: theme.colors.text,
              paddingHorizontal: 14,
              paddingVertical: 12,
              minHeight: 50,
              fontSize: theme.typography.body.fontSize,
            },
            props.style,
          ]}
        />
        {password ? (
          <IconButton
            name={visible ? "eye-off-outline" : "eye-outline"}
            accessibilityLabel={visible ? "Ocultar senha" : "Mostrar senha"}
            onPress={() => setVisible((current) => !current)}
            style={{ marginRight: 4 }}
          />
        ) : null}
      </View>
      {accessoryId ? (
        <InputAccessoryView nativeID={accessoryId}>
          <View
            style={{
              alignItems: "flex-end",
              paddingHorizontal: 8,
              backgroundColor: theme.colors.surfaceSecondary,
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
            }}
          >
            <Button
              label="OK"
              variant="ghost"
              size="small"
              onPress={() => Keyboard.dismiss()}
            />
          </View>
        </InputAccessoryView>
      ) : null}
      {error ? (
        <View style={{ flexDirection: "row", gap: 6 }}>
          <Icon name="alert-circle" size={18} color={theme.colors.errorText} />
          <Text
            accessible={false}
            style={{
              flex: 1,
              color: theme.colors.errorText,
              fontSize: theme.typography.bodySmall.fontSize,
              lineHeight: theme.typography.bodySmall.lineHeight,
            }}
          >
            {error}
          </Text>
        </View>
      ) : helper ? (
        <Text
          accessible={false}
          style={{
            color: theme.colors.textSecondary,
            fontSize: theme.typography.bodySmall.fontSize,
            lineHeight: theme.typography.bodySmall.lineHeight,
          }}
        >
          {helper}
        </Text>
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
  const { colors, radius, spacing, shadow } = useTheme();
  return (
    <View
      style={[
        tone === "surface" ? shadow : null,
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

/** A form screen: safe areas, keyboard handling and an optional header and footer. */
export function FormPage({
  children,
  header,
  footer,
}: {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Screen keyboard header={header} footer={footer} gap={theme.spacing(4)}>
      {children}
    </Screen>
  );
}
