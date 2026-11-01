import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { Icon, type IconName } from "./Icon.tsx";

/** A titled group of rows on one card, like an iOS settings section. */
export function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing(2) }}>
      {title ? (
        <Text
          accessibilityRole="header"
          style={{
            color: theme.colors.text,
            fontSize: theme.typography.title.fontSize,
            lineHeight: theme.typography.title.lineHeight,
            fontWeight: "700",
            paddingHorizontal: theme.spacing(1),
          }}
        >
          {title}
        </Text>
      ) : null}
      <View
        style={[
          {
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radius.large,
            overflow: "hidden",
          },
          theme.shadow,
        ]}
      >
        {children}
      </View>
      {footer ? (
        <Text
          style={{
            color: theme.colors.textSecondary,
            fontSize: theme.typography.bodySmall.fontSize,
            lineHeight: theme.typography.bodySmall.lineHeight,
            paddingHorizontal: theme.spacing(1),
          }}
        >
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One row of a section. With `onPress` the whole row is the button (at least 56 pt) and a
 * chevron says it opens something; `trailing` holds extra controls instead.
 */
export function ListRow({
  title,
  subtitle,
  icon,
  onPress,
  trailing,
  destructive = false,
  disabled = false,
  first = false,
  accessibilityHint,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  onPress?: () => void;
  trailing?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  /** The first row of a section draws no divider above it. */
  first?: boolean;
  accessibilityHint?: string;
}) {
  const theme = useTheme();
  const color = destructive ? theme.colors.errorText : theme.colors.text;
  const content = (
    <>
      {icon ? (
        <Icon
          name={icon}
          size={22}
          color={destructive ? theme.colors.errorText : theme.colors.accentText}
        />
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          style={{
            color,
            fontSize: theme.typography.body.fontSize,
            lineHeight: theme.typography.body.lineHeight,
            fontWeight: "600",
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: theme.typography.bodySmall.fontSize,
              lineHeight: theme.typography.bodySmall.lineHeight,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {onPress && !trailing ? (
        <Icon name="chevron-forward" size={20} color={theme.colors.muted} />
      ) : null}
    </>
  );
  const style = {
    minHeight: 56,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing(3),
    paddingHorizontal: theme.spacing(4),
    paddingVertical: theme.spacing(3),
    borderTopWidth: first ? 0 : 1,
    borderTopColor: theme.colors.border,
  };
  if (!onPress) return <View style={style}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        style,
        {
          backgroundColor: pressed ? theme.colors.primaryLight : "transparent",
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      {content}
    </Pressable>
  );
}
