/**
 * What stops the bag from moving to the next step, in the order the customer can fix it, said
 * next to the main button instead of a silent disabled button (UX audit P1-6). It adds no rule:
 * every condition is one the checkout already enforced. Pure, for tests.
 */
export interface CheckoutConditions {
  ready: boolean;
  busy: boolean;
  pending: boolean;
  empty: boolean;
  unavailableItems: boolean;
  stale: boolean;
  canOrder: boolean;
  settingsLoaded: boolean;
  signedIn: boolean;
  delivery: boolean;
  addressChosen: boolean;
}

export type CheckoutAction =
  | { kind: "sign-in" }
  | { kind: "quote" }
  | { kind: "confirm" }
  | { kind: "blocked"; reason: string };

export function checkoutAction(
  c: CheckoutConditions,
  quoted: boolean,
): CheckoutAction {
  if (c.pending)
    return {
      kind: "blocked",
      reason: "Confira o pedido pendente antes de fazer outro.",
    };
  if (c.empty) return { kind: "blocked", reason: "Sua sacola está vazia." };
  if (c.unavailableItems)
    return {
      kind: "blocked",
      reason: "Remova os itens indisponíveis para continuar.",
    };
  if (!c.ready || c.busy)
    return { kind: "blocked", reason: "Aguarde: atualizando a sacola." };
  if (c.stale)
    return {
      kind: "blocked",
      reason: "O cardápio está desatualizado. Atualize antes de pedir.",
    };
  if (!c.canOrder)
    return {
      kind: "blocked",
      reason: "A loja precisa estar aberta e conectada para receber o pedido.",
    };
  if (!c.settingsLoaded)
    return {
      kind: "blocked",
      reason: "As opções de entrega e pagamento ainda não carregaram.",
    };
  if (!c.signedIn) return { kind: "sign-in" };
  if (c.delivery && !c.addressChosen)
    return { kind: "blocked", reason: "Escolha o endereço de entrega." };
  return quoted ? { kind: "confirm" } : { kind: "quote" };
}
