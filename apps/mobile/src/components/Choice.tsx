import { Pressable, StyleSheet, Text } from "react-native";
import { useTheme } from "../brand/theme.tsx";

interface Props {
  label: string;
  /** Second line, such as a price. */
  detail?: string;
  selected: boolean;
  disabled?: boolean;
  /** Read instead of label and detail, when the visible text needs context (the half). */
  accessibilityLabel?: string;
  /** `radio` picks one of a group; `checkbox` toggles. */
  kind: "radio" | "checkbox";
  onPress: () => void;
}

/**
 * A selectable chip of the builder. Selection is shown by fill, border and a check mark, never by
 * color alone; the touch target is at least 48 dp and the text scales with the system font.
 */
export function Choice({
  label,
  detail,
  selected,
  disabled = false,
  accessibilityLabel,
  kind,
  onPress,
}: Props) {
  const theme = useTheme();
  const foreground = selected ? theme.colors.onPrimary : theme.colors.text;
  return (
    <Pressable
      accessibilityRole={kind}
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={
        accessibilityLabel ?? (detail ? `${label}, ${detail}` : label)
      }
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          borderRadius: theme.radius.small,
          borderColor: selected ? theme.colors.primary : theme.colors.border,
          backgroundColor: selected
            ? pressed
              ? theme.colors.primaryPressed
              : theme.colors.primary
            : theme.colors.surface,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      <Text style={[styles.label, { color: foreground }]}>
        {selected ? "✓ " : ""}
        {label}
      </Text>
      {detail ? (
        <Text
          style={[
            styles.detail,
            { color: selected ? theme.colors.onPrimary : theme.colors.muted },
          ]}
        >
          {detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 2,
    justifyContent: "center",
  },
  label: { fontSize: 16, fontWeight: "700" },
  detail: { fontSize: 14 },
});
