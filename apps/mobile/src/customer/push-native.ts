import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { PushNative } from "./push.ts";

// A notification that arrives with the app open is shown too: the order screen may be closed.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

const permissionOf = (status: string) =>
  status === "granted" || status === "denied" ? status : "undetermined";

/** `expo-notifications` steps of the opt-in; null when this build has no push project. */
export function nativePush(projectId: string | undefined): PushNative | null {
  if (!projectId) return null;
  return {
    permission: async () =>
      permissionOf((await Notifications.getPermissionsAsync()).status),
    async request() {
      // Android 13+ asks only once a channel exists.
      if (Platform.OS === "android")
        await Notifications.setNotificationChannelAsync("default", {
          name: "Pedidos",
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      return permissionOf(
        (await Notifications.requestPermissionsAsync()).status,
      );
    },
    token: async () =>
      (await Notifications.getExpoPushTokenAsync({ projectId })).data,
  };
}

/**
 * Reports every tapped notification with its id and data: the one that launched or resumed the
 * app (`getLastNotificationResponseAsync`) and later taps while it runs, in the background or in
 * the foreground. The same tap may arrive through both; the router keeps each id once.
 */
export function onNotificationOpened(
  open: (notificationId: string, data: unknown) => void,
): () => void {
  let active = true;
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (active && response)
      open(
        response.notification.request.identifier,
        response.notification.request.content.data,
      );
  };
  void Notifications.getLastNotificationResponseAsync().then(handle);
  const subscription =
    Notifications.addNotificationResponseReceivedListener(handle);
  return () => {
    active = false;
    subscription.remove();
  };
}
