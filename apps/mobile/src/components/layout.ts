/**
 * Layout decisions of the shared components, without React Native imports so `node --test`
 * covers them. Insets come from `react-native-safe-area-context`; nothing here guesses a device.
 */

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Breathing room under a fixed bar on a device without a home indicator (iPhone SE, Android). */
export const MIN_BOTTOM_GAP = 12;
/** Horizontal page margin. */
export const PAGE_GUTTER = 20;

/**
 * Bottom padding of the last fixed element on screen: a sticky footer or the tab bar. Inside the
 * tabs the tab bar owns the home indicator, so a footer above it only needs the gap.
 */
export function bottomBarPadding(insets: Insets, aboveTabBar: boolean): number {
  return aboveTabBar ? MIN_BOTTOM_GAP : Math.max(insets.bottom, MIN_BOTTOM_GAP);
}

/**
 * Bottom padding of scrolling content: the last item must scroll clear of the home indicator
 * when nothing fixed sits below the content; a footer or the tab bar already does that.
 */
export function scrollBottomPadding(
  insets: Insets,
  hasFixedBelow: boolean,
  gap: number,
): number {
  return hasFixedBelow ? gap : insets.bottom + gap;
}

/** Spoken label of a main tab: name, item count when there is one, and position. */
export function tabAccessibilityLabel(
  label: string,
  count: number,
  position: number,
  total: number,
): string {
  const items = count > 0 ? `, ${count} ${count === 1 ? "item" : "itens"}` : "";
  return `${label}${items}, aba ${position} de ${total}`;
}

/** Text of the badge on the tab icon; large counts stay short. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

/** `n item`/`n itens`, and so on, in Portuguese. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
