/**
 * Length of a transition in milliseconds: none when the system asks for reduced motion (M5.2,
 * ADR 0021). The state changes at once either way; only the animation is dropped.
 */
export const transitionMs = (reduceMotion: boolean, ms = 220): number =>
  reduceMotion ? 0 : ms;
