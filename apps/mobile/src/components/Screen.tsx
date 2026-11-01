import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentRef,
  type ReactNode,
  type Ref,
} from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewProps,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../brand/theme.tsx";
import { Icon } from "./Icon.tsx";
import {
  PAGE_GUTTER,
  bottomBarPadding,
  scrollBottomPadding,
} from "./layout.ts";

/** True while the main tab bar is drawn under the screen: it owns the home indicator then. */
export const TabBarContext = createContext(false);
export const useAboveTabBar = () => useContext(TabBarContext);

function useKeyboardVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setVisible(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setVisible(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

/**
 * One screen of the app. It owns the safe areas: the header (or a spacer) clears the status bar,
 * Dynamic Island and notch; the footer or the tab bar clears the home indicator; otherwise the
 * last item scrolls clear of it. With `keyboard`, the content and the footer rise with the
 * keyboard, so the field being typed in and the button that sends it stay visible.
 */
export function Screen({
  header,
  footer,
  children,
  scroll = true,
  keyboard = false,
  refreshControl,
  scrollRef,
  gap,
  contentStyle,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  keyboard?: boolean;
  refreshControl?: ScrollViewProps["refreshControl"];
  scrollRef?: Ref<ComponentRef<typeof ScrollView>>;
  gap?: number;
  contentStyle?: ViewStyle;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const aboveTabBar = useAboveTabBar();
  const padding: ViewStyle = {
    paddingLeft: PAGE_GUTTER + insets.left,
    paddingRight: PAGE_GUTTER + insets.right,
    paddingTop: theme.spacing(4),
    paddingBottom: scrollBottomPadding(
      insets,
      !!footer || aboveTabBar,
      theme.spacing(6),
    ),
    gap: gap ?? theme.spacing(5),
  };
  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      style={styles.fill}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
      refreshControl={refreshControl}
      contentContainerStyle={[padding, contentStyle]}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.fill, padding, contentStyle]}>{children}</View>
  );
  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.background }]}>
      {header ?? <View style={{ height: insets.top }} />}
      <KeyboardAvoidingView
        style={styles.fill}
        enabled={keyboard && Platform.OS === "ios"}
        behavior="padding"
      >
        {body}
        {footer}
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * The header of a screen. Stacked screens get a back button that names where it goes; tab
 * screens show only the title. The title is a header for VoiceOver's rotor.
 */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  backTo,
  right,
  large = false,
  backDisabled = false,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  /** Name of the screen the back button returns to, such as "Cardápio". */
  backTo?: string;
  right?: ReactNode;
  /** A large title under the bar, for the main screens. */
  large?: boolean;
  backDisabled?: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + theme.spacing(1),
        paddingLeft: theme.spacing(2) + insets.left,
        paddingRight: theme.spacing(2) + insets.right,
        paddingBottom: large ? theme.spacing(2) : theme.spacing(1),
        backgroundColor: theme.colors.background,
        borderBottomWidth: large ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
      }}
    >
      {!large || onBack || right ? (
        <View style={styles.bar}>
          <View style={styles.side}>
            {onBack ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={backTo ? `Voltar para ${backTo}` : "Voltar"}
                accessibilityState={{ disabled: backDisabled }}
                disabled={backDisabled}
                onPress={onBack}
                hitSlop={4}
                style={({ pressed }) => ({
                  minHeight: 44,
                  minWidth: 44,
                  paddingRight: theme.spacing(2),
                  flexDirection: "row",
                  alignItems: "center",
                  borderRadius: theme.radius.medium,
                  opacity: backDisabled ? 0.4 : pressed ? 0.6 : 1,
                })}
              >
                <Icon
                  name="chevron-back"
                  size={26}
                  color={theme.colors.accentText}
                />
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.4}
                  style={{
                    color: theme.colors.accentText,
                    fontSize: 17,
                    lineHeight: 22,
                    fontWeight: "600",
                    flexShrink: 1,
                  }}
                >
                  {backTo ?? "Voltar"}
                </Text>
              </Pressable>
            ) : null}
          </View>
          {!large ? (
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              maxFontSizeMultiplier={1.4}
              style={[
                styles.title,
                {
                  color: theme.colors.text,
                  fontSize: 17,
                  lineHeight: 22,
                },
              ]}
            >
              {title}
            </Text>
          ) : (
            <View style={styles.titleSpacer} />
          )}
          <View style={[styles.side, styles.right]}>{right}</View>
        </View>
      ) : null}
      {large ? (
        <View
          style={{
            paddingHorizontal: PAGE_GUTTER - theme.spacing(2),
            gap: theme.spacing(1),
          }}
        >
          <Text
            accessibilityRole="header"
            style={{
              color: theme.colors.text,
              fontSize: theme.typography.h1.fontSize,
              lineHeight: theme.typography.h1.lineHeight,
              fontWeight: "800",
            }}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontSize: theme.typography.bodySmall.fontSize,
                lineHeight: theme.typography.bodySmall.lineHeight,
              }}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The fixed action area at the bottom of a screen (the main button, a total). It clears the home
 * indicator, or the tab bar when one is drawn below, and sits right on the keyboard when it opens.
 */
export function StickyFooter({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const aboveTabBar = useAboveTabBar();
  const keyboardVisible = useKeyboardVisible();
  return (
    <View
      style={[
        {
          paddingLeft: PAGE_GUTTER + insets.left,
          paddingRight: PAGE_GUTTER + insets.right,
          paddingTop: theme.spacing(3),
          paddingBottom: keyboardVisible
            ? theme.spacing(3)
            : bottomBarPadding(insets, aboveTabBar),
          backgroundColor: theme.colors.surface,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.colors.border,
          gap: theme.spacing(2),
        },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { minHeight: 48, flexDirection: "row", alignItems: "center" },
  side: { flex: 1, flexDirection: "row", alignItems: "center" },
  right: { justifyContent: "flex-end" },
  title: { flex: 2, textAlign: "center", fontWeight: "700" },
  titleSpacer: { flex: 0 },
});
