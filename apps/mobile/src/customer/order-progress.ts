import {
  type CustomerOrderStatus,
  type Fulfillment,
  statusLabel,
} from "./orders.ts";

/**
 * The steps of an order as the tracking screen draws them (order-lifecycle.md): delivery goes
 * through "Saiu para entrega", pickup does not. Each step says in words whether it is done,
 * current or next, so the progress never depends on color. Pure, for tests.
 */
export type StepState = "done" | "current" | "upcoming";
export interface ProgressStep {
  status: CustomerOrderStatus;
  label: string;
  state: StepState;
}

export function orderSteps(fulfillment: Fulfillment): CustomerOrderStatus[] {
  return fulfillment === "DELIVERY"
    ? ["PLACED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "COMPLETED"]
    : ["PLACED", "PREPARING", "READY", "COMPLETED"];
}

/** Null for a rejected or canceled order: it has no progress to show, only its outcome. */
export function orderProgress(
  status: CustomerOrderStatus,
  fulfillment: Fulfillment,
): ProgressStep[] | null {
  if (status === "REJECTED" || status === "CANCELED") return null;
  const steps = orderSteps(fulfillment);
  const at = steps.indexOf(status);
  return steps.map((step, index) => ({
    status: step,
    label: statusLabel(step, fulfillment),
    state:
      index < at || (index === at && step === "COMPLETED")
        ? "done"
        : index === at
          ? "current"
          : "upcoming",
  }));
}

/** "Etapa 2 de 4: Em preparo", for VoiceOver. */
export function progressSummary(
  status: CustomerOrderStatus,
  fulfillment: Fulfillment,
): string {
  const steps = orderSteps(fulfillment);
  const at = steps.indexOf(status);
  return at < 0
    ? statusLabel(status, fulfillment)
    : `Etapa ${at + 1} de ${steps.length}: ${statusLabel(status, fulfillment)}`;
}

/** The tone of a status badge: icon and color always come with the label. */
export function statusTone(
  status: CustomerOrderStatus,
): "progress" | "success" | "error" {
  return status === "COMPLETED"
    ? "success"
    : status === "REJECTED" || status === "CANCELED"
      ? "error"
      : "progress";
}
