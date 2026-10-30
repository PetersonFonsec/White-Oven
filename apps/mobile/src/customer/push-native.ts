import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { type PushNative, orderIdFromNotification } from "./push.ts";

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
 * Calls `open` with the order of a tapped notification, including the one that launched the app.
 * Returns the unsubscribe function.
 */
export function onOrderNotificationOpened(
  open: (orderId: string) => void,
): () => void {
  let active = true;
  const handle = (response: Notifications.NotificationResponse | null) => {
    const orderId = orderIdFromNotification(
      response?.notification.request.content.data,
    );
    if (active && orderId) open(orderId);
  };
  void Notifications.getLastNotificationResponseAsync().then(handle);
  const subscription =
    Notifications.addNotificationResponseReceivedListener(handle);
  return () => {
    active = false;
    subscription.remove();
  };
}
