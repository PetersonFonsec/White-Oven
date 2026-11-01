import { useEffect, useRef } from "react";
import { Animated, Image, StyleSheet, Text, View } from "react-native";
import type { PizzaMode } from "@whiteoven/contracts";
import { transitionMs } from "../a11y/motion.ts";
import { useReducedMotion } from "../a11y/useReducedMotion.ts";
import { useTheme } from "../brand/theme.tsx";

interface Props {
  mode: PizzaMode;
  /** The text of each half, read by screen readers as the image's description. */
  description: string;
  leftImageUrl?: string | null;
  rightImageUrl?: string | null;
  size?: number;
}

/**
 * The pizza seen from above (M5.2, ADR 0021). The halves differ by fill, by a divider and by a
 * written label, so they stay apart without color and in grayscale. The right half fades in when
 * the pizza is split, unless the system asks for reduced motion.
 */
export function PizzaVisual({
  mode,
  description,
  leftImageUrl = null,
  rightImageUrl = null,
  size = 240,
}: Props) {
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
      {leftImageUrl ? (
        <View
          pointerEvents="none"
          style={[
            styles.fullImage,
            { width: inner, height: inner, borderRadius: inner / 2 },
          ]}
        >
          <Image
            source={{ uri: leftImageUrl }}
            accessible={false}
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            style={{ width: inner, height: inner }}
          />
        </View>
      ) : null}
      <Animated.View
        pointerEvents="none"
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
      >
        {rightImageUrl ? (
          <Image
            source={{ uri: rightImageUrl }}
            accessible={false}
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            style={{ width: inner, height: inner, marginLeft: -half }}
          />
        ) : null}
      </Animated.View>
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
  fullImage: { position: "absolute", top: 0, left: 0, overflow: "hidden" },
  right: { position: "absolute", top: 0, overflow: "hidden" },
  divider: { position: "absolute", top: 0, width: 6 },
  label: {
    position: "absolute",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "800",
  },
});
