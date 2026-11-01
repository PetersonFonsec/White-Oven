/**
 * Navigation of the signed-out screens: welcome, sign-in, sign-up and the e-mail confirmation.
 * Pure (no React Native import), so `node --test` covers it.
 */

export type AuthStep = "welcome" | "login" | "register" | "confirm-email";

/** The steps open on screen, the last one visible. Never empty. */
export type AuthStack = readonly AuthStep[];

/**
 * Where the signed-out flow opens. A screen that sent the customer to sign in (the bag, the
 * orders, a tapped notification) goes straight to the form; the welcome is for everyone else.
 */
export function initialAuthStep(options: {
  /** Another screen asked for a sign-in and the back button returns there. */
  returnsSomewhere: boolean;
  /** A notice explains why the sign-in is needed. */
  hasNotice: boolean;
}): AuthStep {
  return options.returnsSomewhere || options.hasNotice ? "login" : "welcome";
}

/**
 * Opens a step. Switching between sign-in and sign-up replaces the form on screen, so the back
 * button always returns to what came before both (the welcome or the screen that asked).
 */
export function authForward(stack: AuthStack, step: AuthStep): AuthStack {
  const top = stack[stack.length - 1];
  if (top === step) return stack;
  const form = (value: AuthStep | undefined) =>
    value === "login" || value === "register";
  if (form(top) && form(step)) return [...stack.slice(0, -1), step];
  return [...stack, step];
}

/** Goes back one step; null when the flow itself should close (back to whoever opened it). */
export function authBack(stack: AuthStack): AuthStack | null {
  return stack.length > 1 ? stack.slice(0, -1) : null;
}

/**
 * Whether the welcome covers the app at launch, decided once per launch:
 *
 * - "wait" while something it depends on is still unknown (the saved session, the store's state
 *   or the menu, all on their first load).
 * - "show" only for a customer without a saved session, with the store serving its menu: open,
 *   or closed by its hours or paused, since the menu can still be browsed (ADR 0016). Nothing
 *   else is on screen yet (no bag, order or account opened).
 * - "skip" for everything else: signed in, a session that could not be checked, a store that is
 *   unavailable (its own screen keeps priority, ADR 0020), no connection or a menu that failed to
 *   load. The app records "skip" for the launch, so the welcome never pops up later over a menu
 *   the customer is already using.
 */
export type WelcomeDecision = "wait" | "show" | "skip";

export function welcomeDecision(options: {
  ready: boolean;
  session: "idle" | "restoring" | "restored" | "failed";
  signedIn: boolean;
  dismissed: boolean;
  /** What the app would show without the welcome. */
  screen: string;
  /** The store's state, null before the first answer or cached copy. */
  availability: "open" | "closed" | "unavailable" | "offline" | null;
  /** The menu's first load. */
  menu: "loading" | "ok" | "failed";
  /**
   * The welcome is already on screen: a refresh that loses the connection does not pull it away
   * mid-read; only signing in, skipping it, another screen or an unavailable store close it.
   */
  shown: boolean;
}): WelcomeDecision {
  if (options.dismissed) return "skip";
  if (options.signedIn || options.session === "failed") return "skip";
  if (
    options.availability === "unavailable" ||
    options.screen === "unavailable"
  )
    return "skip";
  if (options.shown) return options.screen === "menu" ? "show" : "skip";
  if (!options.ready || options.session !== "restored") return "wait";
  if (options.availability === null || options.screen === "starting")
    return "wait";
  if (options.availability === "offline") return "skip";
  if (options.screen !== "menu") return "skip";
  if (options.menu === "loading") return "wait";
  return options.menu === "ok" ? "show" : "skip";
}

/**
 * The store name in two tones, like the brand: the last word stands out. One word stays plain.
 */
export function brandNameParts(name: string): { lead: string; tail: string } {
  const trimmed = name.trim().replace(/\s+/g, " ");
  const cut = trimmed.lastIndexOf(" ");
  if (cut <= 0) return { lead: trimmed, tail: "" };
  return { lead: trimmed.slice(0, cut + 1), tail: trimmed.slice(cut + 1) };
}

export interface WelcomeSlide {
  title: string;
  /** Part of the title in the accent color, read as one sentence with it. */
  highlight: string;
  body: string;
}

/** The welcome carousel. Only what the app really does (no route tracking, ADR 0023). */
export const WELCOME_SLIDES: readonly WelcomeSlide[] = [
  {
    title: "Peça sua pizza favorita de forma ",
    highlight: "rápida e fácil",
    body: "Monte sua pizza, personalize do seu jeito e acompanhe até ficar pronta.",
  },
  {
    title: "Inteira ou meio a meio, ",
    highlight: "do seu jeito",
    body: "Escolha tamanho, sabores, borda e extras e veja o preço antes de pedir.",
  },
  {
    title: "Acompanhe cada etapa do ",
    highlight: "seu pedido",
    body: "Do forno até a entrega ou retirada, e com avisos no celular se você quiser.",
  },
];

/** The slide a horizontal scroll rests on, kept inside the carousel. */
export function slideAt(offset: number, width: number, count: number): number {
  if (width <= 0 || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(offset / width)));
}
