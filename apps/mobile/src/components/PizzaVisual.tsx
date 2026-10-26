import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import type { PizzaMode } from "@whiteoven/contracts";
import { transitionMs } from "../a11y/motion.ts";
import { useReducedMotion } from "../a11y/useReducedMotion.ts";
import { useTheme } from "../brand/theme.tsx";

interface Props {
  mode: PizzaMode;
  /** The text of each half, read by screen readers as the image's description. */
  description: string;
  size?: number;
}

/**
 * The pizza seen from above (M5.2, ADR 0021). The halves differ by fill, by a divider and by a
 * written label, so they stay apart without color and in grayscale. The right half fades in when
 * the pizza is split, unless the system asks for reduced motion.
 */
export function PizzaVisual({ mode, description, size = 200 }: Props) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const split = useRef(new Animated.Value(mode === "HALVES" ? 1 : 0)).current;

  useEffect(() => {
    const target = mode === "HALVES" ? 1 : 0;
    const duration = transitionMs(reduceMotion);
    if (duration === 0) {
      split.setValue(target);
      return;
    }
    const animation = Animated.timing(split, {
      toValue: target,
      duration,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [mode, reduceMotion, split]);

  // Children are placed inside the crust (the border), so halves split the inner circle.
  const inner = size - 2 * CRUST;
  const half = inner / 2;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={description}
      style={[
        styles.pizza,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors.primary,
          borderColor: theme.colors.primaryPressed,
        },
      ]}
    >
      <Animated.View
        style={[
          styles.right,
          {
            left: half,
            width: half,
            height: inner,
            backgroundColor: theme.colors.surface,
            opacity: split,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.divider,
          {
            left: half - 3,
            height: inner,
            backgroundColor: theme.colors.text,
            opacity: split,
          },
        ]}
      />
      {mode === "HALVES" ? (
        <>
          <Text
            maxFontSizeMultiplier={1.3}
            style={[
              styles.label,
              { left: 0, width: half, color: theme.colors.onPrimary },
            ]}
          >
            Esquerda
          </Text>
          <Text
            maxFontSizeMultiplier={1.3}
            style={[
              styles.label,
              { left: half, width: half, color: theme.colors.text },
            ]}
          >
            Direita
          </Text>
        </>
      ) : (
        <Text
          maxFontSizeMultiplier={1.3}
          style={[
            styles.label,
            { left: 0, width: inner, color: theme.colors.onPrimary },
          ]}
        >
          Inteira
        </Text>
      )}
    </View>
  );
}

const CRUST = 6;

const styles = StyleSheet.create({
  pizza: {
    overflow: "hidden",
    borderWidth: CRUST,
    alignSelf: "center",
    justifyContent: "center",
  },
  right: { position: "absolute", top: 0 },
  divider: { position: "absolute", top: 0, width: 6 },
  label: {
    position: "absolute",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "800",
  },
});
