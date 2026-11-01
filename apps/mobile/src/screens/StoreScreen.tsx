import type { ReactNode } from "react";
import { View } from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { Body, Button, Heading, SurfaceCard } from "../components/Form.tsx";
import { InlineMessage } from "../components/Feedback.tsx";
import { Icon } from "../components/Icon.tsx";
import { Screen } from "../components/Screen.tsx";
import type { StoreMessage } from "./store-messages.ts";

interface Props {
  message: StoreMessage;
  refreshing: boolean;
  onRetry: () => void;
  /** What stays reachable while the store is unavailable: account, orders, pending recovery. */
  actions?: ReactNode;
}

/**
 * A clear, branded notice when the API confirms this store is unavailable. The screen owns the
 * safe areas, so the actions below the notice are never behind the status bar or Dynamic Island.
 */
export function StoreScreen({ message, refreshing, onRetry, actions }: Props) {
  const theme = useTheme();
  return (
    <Screen contentStyle={{ flexGrow: 1, justifyContent: "center" }}>
      {message.notice ? (
        <InlineMessage tone="warning">{message.notice}</InlineMessage>
      ) : null}
      <SurfaceCard>
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: theme.radius.large,
            backgroundColor: theme.colors.primaryLight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name="storefront-outline"
            size={28}
            color={theme.colors.accentText}
          />
        </View>
        <Heading level="h1">{message.title}</Heading>
        <Body muted>{message.body}</Body>
        <Button
          label="Atualizar"
          icon="refresh"
          loading={refreshing}
          variant="primary"
          onPress={onRetry}
        />
      </SurfaceCard>
      {actions ? (
        <View style={{ gap: theme.spacing(3) }}>{actions}</View>
      ) : null}
    </Screen>
  );
}
