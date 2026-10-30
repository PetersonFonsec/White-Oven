import { validatePizzaConfiguration } from "@whiteoven/contracts";
import {
  type Address,
  type CustomerClient,
  CustomerError,
  type Profile,
  type SecretStore,
  customerMessage,
} from "../customer/client.ts";
import { type CartLine, type CheckoutDetails, orderBody } from "./cart.ts";
import {
  parseCustomerOrderDetail,
  parseCustomerOrderPage,
} from "../customer/orders.ts";

export interface Quote {
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  discountCents: number;
  totalCents: number;
  priceChanged: boolean;
}
export interface Receipt {
  customerId: string;
  id: string;
  number: number;
  totalCents: number;
}
export interface Pending {
  customerId: string;
  key: string;
  body: string;
  createdAt: number;
}
interface Saved {
  version: 1;
  cart: CartLine[];
  pending: Pending | null;
  receipt: Receipt | null;
}
/** Restoring the saved session is tracked apart from the cart so either can be retried alone. */
export type SessionStatus = "idle" | "restoring" | "restored" | "failed";
export interface CommerceState extends Saved {
  /** The persisted cart/confirmation was read; commerce actions may run. */
  ready: boolean;
  session: SessionStatus;
  busy: boolean;
  error: string | null;
  profile: Profile | null;
  addresses: Address[];
  quote: { totals: Quote; body: ReturnType<typeof orderBody> } | null;
}
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Dados locais inválidos. Confira pedidos pendentes com a loja antes de continuar.",
    );
  return value as Record<string, unknown>;
}
function cents(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 10_000_000
  );
}
export function parseSaved(raw: string | null): Saved {
  if (raw === null)
    return { version: 1, cart: [], pending: null, receipt: null };
  const value = record(JSON.parse(raw));
  if (
    value.version !== 1 ||
    !Array.isArray(value.cart) ||
    value.cart.length > 30
  )
    throw new Error("Não foi possível restaurar o carrinho.");
  const cart: CartLine[] = value.cart.map((entry: unknown) => {
    const line = record(entry);
    if (
      typeof line.id !== "string" ||
      !uuidPattern.test(line.id) ||
      typeof line.name !== "string" ||
      line.name.length > 500
    )
      throw new Error("Item local inválido.");
    if (line.kind === "PIZZA") {
      const pizza = validatePizzaConfiguration(line.pizza);
      if (!pizza.ok) throw new Error("Pizza local inválida.");
      return {
        id: line.id,
        name: line.name,
        kind: "PIZZA",
        pizza: pizza.value,
      };
    }
    if (
      line.kind !== "PRODUCT" ||
      typeof line.productId !== "string" ||
      !uuidPattern.test(line.productId) ||
      !Number.isInteger(line.quantity) ||
      (line.quantity as number) < 1 ||
      (line.quantity as number) > 20
    )
      throw new Error("Produto local inválido.");
    return {
      id: line.id,
      name: line.name,
      kind: "PRODUCT",
      productId: line.productId,
      quantity: line.quantity as number,
    };
  });
  if (new Set(cart.map((line) => line.id)).size !== cart.length)
    throw new Error("Carrinho local inválido.");
  let pending: Pending | null = null;
  if (value.pending !== null) {
    const p = record(value.pending);
    if (
      typeof p.key !== "string" ||
      !uuidPattern.test(p.key) ||
      typeof p.customerId !== "string" ||
      !uuidPattern.test(p.customerId) ||
      typeof p.body !== "string" ||
      !Number.isSafeInteger(p.createdAt)
    )
      throw new Error(
        "Confirmação local inválida. Confira o pedido com a loja.",
      );
    const body = record(JSON.parse(p.body));
    if (
      !cents(body.expectedTotalCents) ||
      !Array.isArray(body.items) ||
      !body.items.length ||
      body.items.length > 30
    )
      throw new Error("Confirmação local inválida.");
    pending = {
      key: p.key,
      customerId: p.customerId,
      body: p.body,
      createdAt: p.createdAt as number,
    };
  }
  let receipt: Receipt | null = null;
  if (value.receipt !== null) {
    const r = record(value.receipt);
    if (
      typeof r.customerId !== "string" ||
      typeof r.id !== "string" ||
      !uuidPattern.test(r.id) ||
      !Number.isSafeInteger(r.number) ||
      (r.number as number) < 1 ||
      !cents(r.totalCents)
    )
      throw new Error("Comprovante local inválido.");
    receipt = r as unknown as Receipt;
  }
  return { version: 1, cart, pending, receipt };
}
export function parseQuote(raw: unknown): Quote {
  const value = record(raw);
  if (
    ![
      value.itemsSubtotalCents,
      value.deliveryFeeCents,
      value.discountCents,
      value.totalCents,
    ].every(cents) ||
    value.totalCents !==
      (value.itemsSubtotalCents as number) +
        (value.deliveryFeeCents as number) -
        (value.discountCents as number) ||
    typeof value.priceChanged !== "boolean"
  )
    throw new CustomerError(0, "INVALID_RESPONSE");
  return {
    itemsSubtotalCents: value.itemsSubtotalCents as number,
    deliveryFeeCents: value.deliveryFeeCents as number,
    discountCents: value.discountCents as number,
    totalCents: value.totalCents as number,
    priceChanged: value.priceChanged,
  };
}
export function retryAllowed(pending: Pending, now: number): boolean {
  // Keep a margin before the server's 24h expiry; never silently manufacture a new key.
  return (
    now >= pending.createdAt && now - pending.createdAt < 23 * 60 * 60 * 1000
  );
}
export function createCommerceModel(options: {
  client: CustomerClient;
  storage: SecretStore;
  uuid: () => string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const client = options.client;
  let state: CommerceState = {
    version: 1,
    cart: [],
    pending: null,
    receipt: null,
    ready: false,
    session: "idle",
    busy: false,
    error: null,
    profile: null,
    addresses: [],
    quote: null,
  };
  let quoteGeneration = 0;
  let initializing: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<CommerceState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  /**
   * The only way a quote stops being valid: clears it and bumps the generation, so a quote
   * response already in flight can never bring back one computed from older inputs.
   */
  function dropQuote() {
    quoteGeneration++;
    if (state.quote) update({ quote: null });
  }
  async function save(patch: Partial<Saved>) {
    const next = {
      version: 1 as const,
      cart: state.cart,
      pending: state.pending,
      receipt: state.receipt,
      ...patch,
    };
    await options.storage.write(JSON.stringify(next));
    update(next);
  }
  async function run(
    action: () => Promise<void>,
    requireReady = true,
  ): Promise<boolean> {
    if (state.busy || (requireReady && !state.ready)) return false;
    update({ busy: true, error: null });
    try {
      await action();
      return true;
    } catch (error) {
      if (!client.signedIn) dropQuote();
      update({
        error: customerMessage(error),
        ...(client.signedIn ? {} : { profile: null, addresses: [] }),
      });
      return false;
    } finally {
      update({ busy: false });
    }
  }
  async function loadProfile() {
    const p = record(await client.request("me"));
    if (
      typeof p.id !== "string" ||
      !uuidPattern.test(p.id) ||
      typeof p.name !== "string" ||
      typeof p.email !== "string"
    )
      throw new CustomerError(0, "INVALID_RESPONSE");
    update({
      profile: {
        id: p.id,
        name: p.name,
        email: p.email,
        phone: typeof p.phone === "string" ? p.phone : null,
      },
    });
    await loadAddresses();
  }
  async function loadAddresses() {
    const raw = await client.request("me/addresses");
    if (
      !Array.isArray(raw) ||
      raw.length > 10 ||
      raw.some(
        (a) =>
          !a ||
          typeof a.id !== "string" ||
          !uuidPattern.test(a.id) ||
          [
            a.label,
            a.street,
            a.number,
            a.city,
            a.state,
            a.postalCode,
            a.district,
          ].some((s) => typeof s !== "string"),
      )
    )
      throw new CustomerError(0, "INVALID_RESPONSE");
    update({ addresses: raw as Address[] });
  }
  async function sendPending() {
    const pending = state.pending;
    if (!pending || state.profile?.id !== pending.customerId)
      throw new Error(
        "Entre na conta que confirmou este pedido para recuperar o resultado.",
      );
    if (!retryAllowed(pending, now()))
      throw new Error(
        "O prazo de recuperação terminou. Confira o pedido com a loja antes de liberar o carrinho.",
      );
    let raw: unknown;
    try {
      raw = await client.request(
        "me/orders",
        "POST",
        pending.body,
        pending.key,
      );
    } catch (error) {
      // Only explicit transactional rejections prove no order was created. Ambiguous errors keep it locked.
      if (
        error instanceof CustomerError &&
        [
          "ORDER_PRICE_CHANGED",
          "ORDER_INVALID",
          "STORE_CLOSED",
          "STORE_NOT_CONFIGURED",
          "VALIDATION_FAILED",
        ].includes(error.code)
      ) {
        await save({ pending: null });
        dropQuote();
      }
      // A store that stopped serving cannot reconcile the key: the result stays unknown.
      if (error instanceof CustomerError && error.code === "TENANT_NOT_ACTIVE")
        throw new Error(
          "Não foi possível confirmar se o pedido foi recebido: a loja está indisponível. Confira diretamente com a pizzaria antes de liberar o carrinho.",
        );
      throw error;
    }
    const r = record(raw);
    if (
      typeof r.id !== "string" ||
      !uuidPattern.test(r.id) ||
      !Number.isSafeInteger(r.number) ||
      (r.number as number) < 1 ||
      !cents(r.totalCents)
    )
      throw new CustomerError(0, "INVALID_RESPONSE");
    // One durable commit clears the cart and records success. A failed commit keeps the same retry.
    await save({
      cart: [],
      pending: null,
      receipt: {
        customerId: pending.customerId,
        id: r.id,
        number: r.number as number,
        totalCents: r.totalCents,
      },
    });
    dropQuote();
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Loads the saved commerce state once, then restores the session. Each step is retried
     * independently: a session failure keeps the cart usable and never re-reads it over newer changes.
     */
    init() {
      if (initializing) return initializing;
      if (state.ready && state.session === "restored")
        return Promise.resolve(true);
      initializing = run(async () => {
        if (!state.ready) {
          const saved = parseSaved(await options.storage.read());
          update({ ...saved, ready: true });
        }
        if (state.session === "restored") return;
        update({ session: "restoring" });
        try {
          await client.restore();
          if (client.signedIn) await loadProfile();
          update({ session: "restored" });
        } catch (error) {
          update({ session: "failed" });
          throw error;
        }
      }, false).finally(() => {
        initializing = null;
      });
      return initializing;
    },
    signIn: (mode: "login" | "register", body: unknown) =>
      run(async () => {
        // An explicit sign-in supersedes any saved session still waiting for restoration.
        dropQuote();
        update({ profile: null, addresses: [], session: "restored" });
        await client.signIn(mode, body);
        await loadProfile();
      }),
    logout: () =>
      run(async () => {
        await client.logout();
        dropQuote();
        update({ profile: null, addresses: [] });
        if (!state.pending) await save({ cart: [], receipt: null });
      }),
    deleteAccount: (password: string) =>
      run(async () => {
        if (state.pending)
          throw new Error("Confira primeiro o resultado do pedido pendente.");
        await client.request("me", "DELETE", { password });
        await client.forget();
        dropQuote();
        update({ profile: null, addresses: [] });
        await save({ cart: [], receipt: null });
      }),
    refreshAccount: () => run(loadProfile),
    saveAddress: (address: Omit<Address, "id">, id?: string) =>
      run(async () => {
        if (state.pending)
          throw new Error("Confira primeiro o resultado do pedido pendente.");
        dropQuote();
        await client.request(
          id ? `me/addresses/${encodeURIComponent(id)}` : "me/addresses",
          id ? "PUT" : "POST",
          address,
        );
        await loadAddresses();
      }),
    removeAddress: (id: string) =>
      run(async () => {
        if (state.pending)
          throw new Error("Confira primeiro o resultado do pedido pendente.");
        dropQuote();
        await client.request(
          `me/addresses/${encodeURIComponent(id)}`,
          "DELETE",
        );
        await loadAddresses();
      }),
    changeCart: (change: (lines: CartLine[]) => CartLine[]) =>
      run(async () => {
        if (state.pending)
          throw new Error(
            "Recupere o pedido pendente antes de alterar o carrinho.",
          );
        dropQuote();
        const cart = change(state.cart);
        await save({ cart, receipt: null });
      }),
    replaceCart: (lines: CartLine[]) =>
      run(async () => {
        if (state.pending)
          throw new Error(
            "Recupere o pedido pendente antes de trocar o carrinho.",
          );
        dropQuote();
        await save({ cart: lines, receipt: null });
      }),
    listCustomerOrders: async (cursor: number | null = null) => {
      const suffix = cursor === null ? "" : `?cursor=${cursor}`;
      return parseCustomerOrderPage(await client.request(`me/orders${suffix}`));
    },
    getCustomerOrder: async (orderId: string) =>
      parseCustomerOrderDetail(
        await client.request(`me/orders/${encodeURIComponent(orderId)}`),
      ),
    cancelCustomerOrder: async (orderId: string, key: string) =>
      client.request(
        `me/orders/${encodeURIComponent(orderId)}/transitions`,
        "POST",
        { from: "PLACED", to: "CANCELED", reasonCode: "CUSTOMER_REQUEST" },
        key,
      ),
    invalidateQuote: dropQuote,
    quote: (details: CheckoutDetails, expectedTotalCents: number) =>
      run(async () => {
        if (!state.profile) throw new CustomerError(401, "LOGIN_REQUIRED");
        if (state.pending)
          throw new Error("Recupere o pedido pendente primeiro.");
        if (!state.cart.length) throw new Error("Adicione itens ao carrinho.");
        const body = orderBody(state.cart, details);
        dropQuote();
        const generation = quoteGeneration;
        const totals = parseQuote(
          await client.request("me/orders/quote", "POST", {
            ...body,
            expectedTotalCents,
          }),
        );
        if (generation === quoteGeneration) update({ quote: { totals, body } });
      }),
    confirm: () =>
      run(async () => {
        if (!state.pending) {
          const quote = state.quote;
          if (!quote || !state.profile)
            throw new Error("Solicite uma cotação antes de confirmar.");
          await save({
            pending: {
              customerId: state.profile.id,
              key: options.uuid(),
              createdAt: now(),
              body: JSON.stringify({
                ...quote.body,
                expectedTotalCents: quote.totals.totalCents,
              }),
            },
          });
          dropQuote();
        }
        await sendPending();
      }),
    // Explicit user acknowledgement only, after contacting the store. Never offered as a retry shortcut.
    acknowledgePending: () =>
      run(async () => {
        if (!state.pending || state.profile?.id !== state.pending.customerId)
          throw new Error("Entre na conta que confirmou o pedido.");
        await save({ pending: null, cart: [] });
        dropQuote();
      }),
  };
}
export type CommerceModel = ReturnType<typeof createCommerceModel>;
