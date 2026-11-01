import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { transitionMs } from "../a11y/motion.ts";
import { announce, useAnnouncement } from "../a11y/useAnnouncement.ts";
import { useReducedMotion } from "../a11y/useReducedMotion.ts";
import { useTheme } from "../brand/theme.tsx";
import { Icon, type IconName } from "./Icon.tsx";

export type MessageTone = "error" | "warning" | "info" | "success";

const ICONS: Record<MessageTone, IconName> = {
  error: "alert-circle",
  warning: "warning",
  info: "information-circle",
  success: "checkmark-circle",
};

/**
 * A message in the flow of the screen: an icon and a title tell the tone, so it does not depend on
 * color. Errors and warnings are announced to VoiceOver when they appear.
 */
export function InlineMessage({
  tone,
  title,
  children,
  action,
}: {
  tone: MessageTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const theme = useTheme();
  const spoken =
    typeof children === "string"
      ? [title, children].filter(Boolean).join(". ")
      : (title ?? null);
  useAnnouncement(spoken, tone === "error" || tone === "warning");
  const palette = {
    error: {
      background: theme.colors.errorSurface,
      border: theme.colors.error,
      icon: theme.colors.errorText,
    },
    warning: {
      background: theme.colors.surfaceSecondary,
      border: theme.colors.warning,
      icon: theme.colors.accentText,
    },
    info: {
      background: theme.colors.surfaceSecondary,
      border: theme.colors.border,
      icon: theme.colors.accentText,
    },
    success: {
      background: theme.colors.surface,
      border: theme.colors.success,
      icon: theme.colors.success,
    },
  }[tone];
  return (
    <View
      accessibilityRole={tone === "error" ? "alert" : undefined}
      accessibilityLiveRegion={
        tone === "error" || tone === "warning" ? "polite" : undefined
      }
      style={{
        flexDirection: "row",
        gap: theme.spacing(3),
        padding: theme.spacing(3),
        borderRadius: theme.radius.medium,
        backgroundColor: palette.background,
        borderLeftWidth: 4,
        borderLeftColor: palette.border,
      }}
    >
      <Icon name={ICONS[tone]} size={22} color={palette.icon} />
      <View style={{ flex: 1, gap: theme.spacing(1) }}>
        {title ? (
          <Text
            style={{
              color:
                tone === "error" ? theme.colors.errorText : theme.colors.text,
              fontSize: theme.typography.body.fontSize,
              lineHeight: theme.typography.body.lineHeight,
              fontWeight: "700",
            }}
          >
            {title}
          </Text>
        ) : null}
        {typeof children === "string" ? (
          <Text
            style={{
              color: theme.colors.text,
              fontSize: theme.typography.bodySmall.fontSize,
              lineHeight: theme.typography.bodySmall.lineHeight,
            }}
          >
            {children}
          </Text>
        ) : (
          children
        )}
        {action ? (
          <View style={{ alignSelf: "flex-start" }}>{action}</View>
        ) : null}
      </View>
    </View>
  );
}

interface ToastMessage {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

const ToastContext = createContext<(message: Omit<ToastMessage, "id">) => void>(
  () => {},
);
export const useToast = () => useContext(ToastContext);

/**
 * A short confirmation over the bottom of the screen ("Adicionado à sacola"), spoken by
 * VoiceOver. It stays 4 s (6 s with an action), moves only when reduced motion is off, and never
 * covers the tab bar or a sticky footer: `bottomOffset` places it above them.
 */
export function ToastProvider({
  children,
  bottomOffset,
}: {
  children: ReactNode;
  bottomOffset: number;
}) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const nextId = useRef(0);
  const show = useCallback((message: Omit<ToastMessage, "id">) => {
    nextId.current += 1;
    setToast({ ...message, id: nextId.current });
    announce(message.text);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const duration = transitionMs(reduceMotion, 180);
    if (duration)
      Animated.timing(opacity, {
        toValue: 1,
        duration,
        useNativeDriver: true,
      }).start();
    else opacity.setValue(1);
    const timer = setTimeout(
      () => setToast((current) => (current?.id === toast.id ? null : current)),
      toast.actionLabel ? 6000 : 4000,
    );
    return () => clearTimeout(timer);
  }, [toast, reduceMotion, opacity]);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <Animated.View
          pointerEvents="box-none"
          style={{
            position: "absolute",
            left: 16,
            right: 16,
            bottom: bottomOffset + 12,
            opacity,
          }}
        >
          <View
            style={[
              {
                flexDirection: "row",
                alignItems: "center",
                gap: theme.spacing(3),
                paddingVertical: theme.spacing(3),
                paddingLeft: theme.spacing(4),
                paddingRight: theme.spacing(2),
                borderRadius: theme.radius.large,
                backgroundColor: theme.colors.text,
              },
              theme.shadow,
            ]}
          >
            <Icon
              name="checkmark-circle"
              size={22}
              color={theme.colors.surface}
            />
            <Text
              style={{
                flex: 1,
                color: theme.colors.surface,
                fontSize: theme.typography.body.fontSize,
                lineHeight: theme.typography.body.lineHeight,
                fontWeight: "600",
              }}
            >
              {toast.text}
            </Text>
            {toast.actionLabel && toast.onAction ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  setToast(null);
                  toast.onAction?.();
                }}
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: theme.spacing(3),
                  justifyContent: "center",
                  borderRadius: theme.radius.medium,
                  backgroundColor: pressed ? "#3A302B" : "transparent",
                })}
              >
                <Text
                  style={{
                    color: theme.colors.surface,
                    fontSize: theme.typography.body.fontSize,
                    fontWeight: "700",
                    textDecorationLine: "underline",
                  }}
                >
                  {toast.actionLabel}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}
