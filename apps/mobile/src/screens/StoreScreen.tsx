import { ScrollView, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { Body, Button, Heading, SurfaceCard } from "../components/Form.tsx";
import type { StoreMessage } from "./store-messages.ts";

interface Props {
  message: StoreMessage;
  refreshing: boolean;
  onRetry: () => void;
}

/** A clear, branded notice when the API confirms this store is unavailable. */
export function StoreScreen({ message, refreshing, onRetry }: Props) {
  const theme = useTheme();
  const notice = message.screen !== "store";
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        padding: theme.spacing(5),
        gap: theme.spacing(4),
      }}
    >
      {message.notice ? (
        <SurfaceCard tone="secondary">
          <Body>{message.notice}</Body>
        </SurfaceCard>
      ) : null}
      <SurfaceCard>
        <View
          accessible={false}
          style={{
            width: 56,
            height: 56,
            borderRadius: theme.radius.large,
            backgroundColor: theme.colors.primaryLight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Body centered>🍕</Body>
        </View>
        <Heading level="h1">{message.title}</Heading>
        <Body muted>{message.body}</Body>
        <Button
          label="Atualizar"
          loading={refreshing}
          variant="primary"
          style={{ alignSelf: "flex-start" }}
          onPress={onRetry}
        />
      </SurfaceCard>
    </ScrollView>
  );
}
