import { Pressable, Text, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";

/**
 * Two to four exclusive options side by side (Entrar | Criar conta). The selected one is raised
 * and bold, not only colored; VoiceOver reads them as tabs with their position.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        padding: 4,
        gap: 4,
        borderRadius: theme.radius.medium + 4,
        backgroundColor: theme.colors.surfaceSecondary,
      }}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityLabel={`${option.label}, ${index + 1} de ${options.length}`}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={[
              {
                flex: 1,
                minHeight: 44,
                paddingHorizontal: theme.spacing(2),
                alignItems: "center",
                justifyContent: "center",
                borderRadius: theme.radius.medium,
                backgroundColor: selected
                  ? theme.colors.surface
                  : "transparent",
              },
              selected ? theme.shadow : null,
            ]}
          >
            <Text
              style={{
                color: selected
                  ? theme.colors.text
                  : theme.colors.textSecondary,
                fontSize: theme.typography.body.fontSize,
                lineHeight: theme.typography.body.lineHeight,
                fontWeight: selected ? "700" : "500",
                textAlign: "center",
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
