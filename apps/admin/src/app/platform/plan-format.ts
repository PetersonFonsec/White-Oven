import type { Plan, PlanCode } from "./platform-api";

const PLAN_NAMES: Record<PlanCode, string> = { FLEX: "Flex", PRO: "Pro" };

export const planName = (code: PlanCode): string => PLAN_NAMES[code];

/** "3% por venda, sem mensalidade" from the values recorded for a plan or period. */
export function planTerms(
  plan: Pick<Plan, "feeBasisPoints" | "monthlyFeeCents">,
): string {
  const fee =
    plan.feeBasisPoints > 0
      ? `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(plan.feeBasisPoints / 100)}% por venda`
      : "sem comissão por venda";
  const monthly =
    plan.monthlyFeeCents > 0
      ? `${new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(plan.monthlyFeeCents / 100)} por mês`
      : "sem mensalidade";
  return `${fee}, ${monthly}`;
}

/**
 * A plan date as the store's calendar day. Periods start at midnight in the store's IANA time
 * zone (ADR 0024), so formatting in the operator's browser zone could show the previous day. An
 * unknown zone falls back to UTC and says so instead of breaking the page.
 */
export function planDate(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "long",
      timeZone,
    }).format(date);
  } catch {
    return `${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "UTC" }).format(date)} (UTC)`;
  }
}
