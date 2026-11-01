import { Text, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { IconButton } from "./Icon.tsx";

/**
 * − quantity +. Each button is 44 × 44 pt and names the item it changes; the number is read as
 * "Quantidade de Margherita: 2" and announced when it changes.
 */
export function QuantityStepper({
  value,
  min,
  max,
  itemName,
  disabled = false,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  /** Spoken in the labels: "Diminuir quantidade de Margherita". */
  itemName?: string;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  const theme = useTheme();
  const of = itemName ? ` de ${itemName}` : "";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        borderRadius: theme.radius.pill,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
      }}
    >
      <IconButton
        name="remove"
        accessibilityLabel={`Diminuir quantidade${of}`}
        disabled={disabled || value <= min}
        onPress={() => onChange(value - 1)}
      />
      <Text
        accessibilityLabel={`Quantidade${of}: ${value}`}
        accessibilityLiveRegion="polite"
        style={{
          minWidth: 32,
          textAlign: "center",
          color: theme.colors.text,
          fontSize: theme.typography.title.fontSize,
          lineHeight: theme.typography.title.lineHeight,
          fontWeight: "700",
        }}
      >
        {value}
      </Text>
      <IconButton
        name="add"
        accessibilityLabel={`Aumentar quantidade${of}`}
        disabled={disabled || value >= max}
        onPress={() => onChange(value + 1)}
      />
    </View>
  );
}
