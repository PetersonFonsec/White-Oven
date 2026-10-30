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
  register(token: string, installationId: string): Promise<unknown>;
  /** Ends this session's subscription and any older one of this installation. */
  unregister(installationId: string): Promise<unknown>;
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

/**
 * Order notifications as one app installation (ADR 0027): `installation` is a random id kept in
 * the device's secure storage, created on first use. It is not a hardware id; reinstalling the
 * app creates another.
 */
export function createPushModel(options: {
  api: PushApi;
  native: PushNative | null;
  installation: () => Promise<string>;
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
  async function installationId(): Promise<string> {
    const id = await options.installation();
    if (!UUID.test(id)) throw new Error("installation id unavailable");
    return id;
  }
  async function register(native: PushNative): Promise<PushStatus> {
    const token = await native.token();
    if (!EXPO_PUSH_TOKEN.test(token))
      throw new Error("Este aparelho não forneceu um endereço de avisos.");
    return enabledOf(await options.api.register(token, await installationId()))
      ? "on"
      : "off";
  }
  /**
   * Reads the signed-in session's opt-in. When on and allowed, the current token is registered
   * again, so a token Expo rotated replaces the old one. When off, any subscription an earlier
   * account left on this installation is ended: the device now belongs to this account.
   */
  async function current(native: PushNative): Promise<PushStatus> {
    if (!enabledOf(await options.api.status())) {
      await options.api.unregister(await installationId());
      return "off";
    }
    if ((await native.permission()) !== "granted") return "denied";
    return register(native);
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
        return register(native);
      }),
    disable: () =>
      run(async () => {
        await options.api.unregister(await installationId());
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

/** Where a tapped order notification leads, once the session is known. */
export type NotificationRoute =
  | { kind: "none" }
  | { kind: "wait" }
  | { kind: "order"; orderId: string }
  | { kind: "login"; orderId: string };

/**
 * Tapped order notifications (ADR 0027). A tap is kept until the session restoration ended, so
 * no order opens for a session that is still being restored, and a signed-out app goes to the
 * account screen instead. The id only names the order: the API still decides whether this
 * account may read it (another account's order is a 404). Each notification opens once, whether
 * the cold-start response and the listener both report it.
 */
export function createNotificationRouter() {
  const seen = new Set<string>();
  let pending: string | null = null;
  return {
    /** Records a tap; false when the data is not an order of this app or was handled already. */
    opened(notificationId: string, data: unknown): boolean {
      const orderId = orderIdFromNotification(data);
      if (!orderId || seen.has(notificationId)) return false;
      seen.add(notificationId);
      pending = orderId;
      return true;
    },
    /** `session` as the commerce model reports it; `signedIn` once a profile is loaded. */
    take(session: {
      status: "idle" | "restoring" | "restored" | "failed";
      signedIn: boolean;
    }): NotificationRoute {
      if (!pending) return { kind: "none" };
      if (session.status === "idle" || session.status === "restoring")
        return { kind: "wait" };
      const orderId = pending;
      pending = null;
      return session.signedIn
        ? { kind: "order", orderId }
        : { kind: "login", orderId };
    },
  };
}
