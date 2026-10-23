export const EVENTS = [
  "landing_view",
  "pizza_builder_interaction",
  "pricing_view",
  "plan_interest_click",
  "lead_form_started",
  "lead_form_submitted",
  "lead_form_success",
  "lead_form_error",
] as const;
export type AnalyticsEvent = {
  name: (typeof EVENTS)[number];
  pageId: string;
  plan?: "FLEX" | "PRO" | "UNDECIDED";
};
export type AnalyticsAdapter = (event: Readonly<AnalyticsEvent>) => void;
// Local only, ephemeral page identifier. No storage, external SDK or network transport.
const pageId = crypto.randomUUID();
let adapter: AnalyticsAdapter = (event) =>
  window.dispatchEvent(
    new CustomEvent("whiteoven:analytics", { detail: event }),
  );
export function setAnalyticsAdapter(next: AnalyticsAdapter | null) {
  adapter = next ?? (() => {});
}
export function track(
  name: AnalyticsEvent["name"],
  plan?: AnalyticsEvent["plan"],
) {
  if (!EVENTS.includes(name)) return;
  const event: AnalyticsEvent = { name, pageId };
  if (plan && ["FLEX", "PRO", "UNDECIDED"].includes(plan)) event.plan = plan;
  try {
    adapter(Object.freeze(event));
  } catch {
    /* Analytics must never break the form. */
  }
}
