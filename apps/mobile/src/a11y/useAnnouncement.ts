import { useEffect } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/**
 * Speaks `message` to VoiceOver when it appears or changes. iOS ignores `accessibilityLiveRegion`
 * and does not read `accessibilityRole="alert"` by itself, so errors and confirmations would pass
 * in silence; Android keeps the live region, which already reads them.
 */
export function useAnnouncement(
  message: string | null | undefined,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled || !message || Platform.OS !== "ios") return;
    // A short delay lets a focus change caused by the same tap finish first.
    const timer = setTimeout(
      () => AccessibilityInfo.announceForAccessibility(message),
      150,
    );
    return () => clearTimeout(timer);
  }, [message, enabled]);
}

/** Speaks a message once, outside a render (after an action). */
export function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
}
