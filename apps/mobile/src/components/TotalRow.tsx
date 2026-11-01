import { Text, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";

/** One label and amount of an order summary, read by VoiceOver as one sentence. */
export function TotalRow({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  const theme = useTheme();
  const type = strong ? theme.typography.title : theme.typography.body;
  const style = {
    color: theme.colors.text,
    fontSize: type.fontSize,
    lineHeight: type.lineHeight,
    fontWeight: strong ? ("800" as const) : ("400" as const),
  };
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={{ flexDirection: "row", gap: theme.spacing(3) }}
    >
      <Text style={[style, { flex: 1 }]}>{label}</Text>
      <Text style={style}>{value}</Text>
    </View>
  );
}
