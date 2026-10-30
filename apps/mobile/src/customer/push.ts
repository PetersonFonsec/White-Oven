import { CustomerError, customerMessage } from "./client.ts";

/**
 * Opt-in order notifications of this device (M5.5, ADR 0027). No native import: the screen gives
 * the permission and token steps, so the decisions here run under `node --test`.
 */
export type PermissionStatus = "granted" | "denied" | "undetermined";
export interface PushNative {
  /** Current OS permission, without asking. */
  permission(): Promise<PermissionStatus>;
  /** Asks the OS; only after the customer tapped to turn notifications on. */
  request(): Promise<PermissionStatus>;
  /** The Expo push token of this installation. */
  token(): Promise<string>;
}
export interface PushApi {
  status(): Promise<unknown>;
  register(token: string): Promise<unknown>;
  unregister(): Promise<unknown>;
}

/**
 * `unavailable`: this build has no push project; `unknown`: not read yet; `denied`: the customer
 * opted in but the OS blocks notifications, so only the device settings can turn them back on.
 */
export type PushStatus = "unavailable" | "unknown" | "off" | "on" | "denied";
export interface PushState {
  status: PushStatus;
  busy: boolean;
  error: string | null;
}

export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function enabledOf(raw: unknown): boolean {
  const value = (raw as { enabled?: unknown } | null)?.enabled;
  if (typeof value !== "boolean")
    throw new CustomerError(0, "INVALID_RESPONSE");
  return value;
}

/** The order a tapped notification is about; null for anything this app did not send. */
export function orderIdFromNotification(data: unknown): string | null {
  const value = data as { type?: unknown; orderId?: unknown } | null;
  return value?.type === "order-status" &&
    typeof value.orderId === "string" &&
    UUID.test(value.orderId)
    ? value.orderId
    : null;
}

export function createPushModel(options: {
  api: PushApi;
  native: PushNative | null;
}) {
  let state: PushState = {
    status: options.native ? "unknown" : "unavailable",
    busy: false,
    error: null,
  };
  // A reset (sign out, another account) makes any answer still in flight stale.
  let generation = 0;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<PushState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  async function run(action: (native: PushNative) => Promise<PushStatus>) {
    const native = options.native;
    if (!native || state.busy) return;
    const started = generation;
    update({ busy: true, error: null });
    try {
      const status = await action(native);
      if (started === generation) update({ status });
    } catch (error) {
      if (started === generation)
        update({
          error:
            error instanceof CustomerError
              ? customerMessage(error)
              : "Não foi possível alterar os avisos do pedido. Tente novamente.",
        });
    } finally {
      if (started === generation) update({ busy: false });
    }
  }
  /** On when the API has this session's device and the OS still allows notifications. */
  async function current(native: PushNative): Promise<PushStatus> {
    if (!enabledOf(await options.api.status())) return "off";
    return (await native.permission()) === "granted" ? "on" : "denied";
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Reads the opt-in of the signed-in session. Never asks for permission. */
    refresh: () => run(current),
    /**
     * The customer's explicit opt-in: asks the OS only now, then registers the token. A refusal
     * leaves the API untouched.
     */
    enable: () =>
      run(async (native) => {
        let permission = await native.permission();
        if (permission !== "granted") permission = await native.request();
        if (permission !== "granted") return "denied";
        const token = await native.token();
        if (!EXPO_PUSH_TOKEN.test(token))
          throw new Error("Este aparelho não forneceu um endereço de avisos.");
        return enabledOf(await options.api.register(token)) ? "on" : "off";
      }),
    disable: () =>
      run(async () => {
        await options.api.unregister();
        return "off";
      }),
    /** Signed out or another account: the server already ended the old session's device. */
    reset() {
      generation++;
      update({
        status: options.native ? "unknown" : "unavailable",
        busy: false,
        error: null,
      });
    },
  };
}
export type PushModel = ReturnType<typeof createPushModel>;
