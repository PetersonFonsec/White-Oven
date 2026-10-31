/** Transport/session logic has no native imports; credentials never enter the public cache. */
export interface SecretStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}
export class CustomerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, details?: unknown) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export interface Profile {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  /** The store published a privacy policy or terms version this account has not accepted. */
  legalUpdateRequired: boolean;
}
export interface Address {
  id: string;
  label: string;
  postalCode: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  city: string;
  state: string;
  reference: string | null;
}
interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
function tokens(raw: unknown): Tokens {
  const value = raw as Partial<Tokens> | null;
  if (
    !value ||
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    typeof value.refreshToken !== "string" ||
    !value.refreshToken ||
    typeof value.expiresIn !== "number" ||
    value.expiresIn <= 0
  )
    throw new CustomerError(0, "INVALID_RESPONSE");
  return value as Tokens;
}
export function createCustomerClient(options: {
  apiUrl: string;
  storeSlug: string;
  fetch: typeof globalThis.fetch;
  secret: SecretStore;
  now?: () => number;
  timeoutMs?: number;
}) {
  const base = `${options.apiUrl}/v1/customer/stores/${encodeURIComponent(options.storeSlug)}`;
  const now = options.now ?? Date.now;
  let access: string | null = null;
  let expires = 0;
  let refreshing: Promise<void> | null = null;
  // Set when a sign-in replaces the session: nothing may refresh back into the previous identity.
  let replaced = false;
  // Changes whenever the signed-in identity may change (sign-in, logout): a request bound to an
  // older value is refused before it reads a token, so it never runs as another account.
  let identity = 0;
  async function raw(
    path: string,
    method: string,
    body?: string,
    token?: string,
    key?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 15000);
    const abortFromCaller = () => abort.abort();
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    try {
      const response = await options.fetch(`${base}/${path}`, {
        method,
        signal: abort.signal,
        credentials: "omit",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(body ? { body } : {}),
      });
      if (response.status === 204) return null;
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = data as { code?: unknown; details?: unknown } | null;
        throw new CustomerError(
          response.status,
          typeof error?.code === "string" ? error.code : "REQUEST_FAILED",
          error?.details,
        );
      }
      if (data === null) throw new CustomerError(0, "INVALID_RESPONSE");
      return data;
    } catch (error) {
      if (error instanceof CustomerError) throw error;
      if (signal?.aborted) throw new CustomerError(0, "ABORTED");
      throw new CustomerError(0, "NETWORK");
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      clearTimeout(timeout);
    }
  }
  async function persist(step: () => Promise<void>) {
    try {
      await step();
    } catch {
      throw new CustomerError(0, "STORAGE");
    }
  }
  async function accept(value: unknown) {
    const next = tokens(value);
    await persist(() => options.secret.write(next.refreshToken));
    access = next.accessToken;
    expires = now() + next.expiresIn * 1000 - 30000;
    replaced = false;
  }
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      access = null;
      if (replaced) throw new CustomerError(401, "LOGIN_REQUIRED");
      const saved = await options.secret.read();
      if (!saved) throw new CustomerError(401, "LOGIN_REQUIRED");
      const owner = identity;
      // Consume before rotation: a lost response must never replay a spent refresh token.
      await options.secret.remove();
      let rotated: unknown;
      try {
        rotated = await raw(
          "auth/refresh",
          "POST",
          JSON.stringify({ refreshToken: saved }),
        );
      } catch (error) {
        // 429 is answered before the API reads the token (ADR 0031): it was not spent, so keep
        // it, unless a sign-in or logout took over the session meanwhile.
        if (
          error instanceof CustomerError &&
          error.status === 429 &&
          !replaced &&
          owner === identity
        )
          await persist(() => options.secret.write(saved));
        throw error;
      }
      await accept(rotated);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  return {
    get signedIn() {
      return access !== null;
    },
    /** The current identity, for `request(..., boundTo)`. */
    get identity() {
      return identity;
    },
    async restore() {
      if (replaced) return;
      const saved = await options.secret.read();
      // A sign-in may have started while reading; it owns the session from then on.
      if (saved && !replaced) await refresh();
    },
    /**
     * Replacing the session ends the previous one first, so a failed attempt (wrong password,
     * network, storage) leaves the client signed out instead of silently refreshing back into it.
     */
    async signIn(mode: "login" | "register", body: unknown) {
      identity++;
      replaced = true;
      access = null;
      // A rotation already in flight could persist the previous identity after the removal below.
      await refreshing?.catch(() => undefined);
      replaced = true;
      access = null;
      const previous = await options.secret.read().catch(() => null);
      await persist(() => options.secret.remove());
      // Best-effort server revocation; the token is already gone locally and is never replayed.
      if (previous)
        await raw(
          "auth/logout",
          "POST",
          JSON.stringify({ refreshToken: previous }),
        ).catch(() => undefined);
      await accept(await raw(`auth/${mode}`, "POST", JSON.stringify(body)));
      // A call bound while the sign-in was still running belongs to neither account.
      identity++;
    },
    async request(
      path: string,
      method = "GET",
      body?: unknown,
      key?: string,
      signal?: AbortSignal,
      boundTo?: number,
    ): Promise<unknown> {
      // Checked synchronously right before each token is read, after every wait.
      const stale = () =>
        signal?.aborted || (boundTo !== undefined && boundTo !== identity);
      if (stale()) throw new CustomerError(0, "ABORTED");
      if (!access || now() >= expires) await refresh();
      if (stale()) throw new CustomerError(0, "ABORTED");
      const sentToken = access!;
      const encoded =
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body);
      try {
        return await raw(path, method, encoded, sentToken, key, signal);
      } catch (error) {
        if (!(error instanceof CustomerError) || error.status !== 401)
          throw error;
        if (stale()) throw new CustomerError(0, "ABORTED");
        // Concurrent 401s share one rotation, even when one response arrives late.
        if (access === sentToken || !access) await refresh();
        if (stale()) throw new CustomerError(0, "ABORTED");
        return raw(path, method, encoded, access!, key, signal);
      }
    },
    async logout() {
      identity++;
      const saved = await options.secret.read();
      // Keep the token if server revocation cannot be confirmed, allowing an explicit retry.
      if (saved)
        await raw(
          "auth/logout",
          "POST",
          JSON.stringify({ refreshToken: saved }),
        );
      await options.secret.remove();
      access = null;
    },
    async forget() {
      identity++;
      await options.secret.remove();
      access = null;
    },
  };
}
export type CustomerClient = ReturnType<typeof createCustomerClient>;

const messages: Record<string, string> = {
  STORAGE:
    "Não foi possível salvar a sessão com segurança neste dispositivo. Entre novamente.",
  NETWORK:
    "Não foi possível confirmar a resposta. Confira a conexão e tente novamente.",
  INVALID_RESPONSE:
    "A resposta da loja não pôde ser confirmada. Tente novamente.",
  LOGIN_REQUIRED: "Entre na sua conta para continuar.",
  INVALID_CREDENTIALS: "E-mail ou senha incorretos.",
  RATE_LIMITED: "Muitas tentativas. Aguarde um pouco e tente novamente.",
  EMAIL_TAKEN: "Este e-mail já possui uma conta nesta loja.",
  PHONE_TAKEN: "Este telefone já está cadastrado.",
  STORE_CLOSED: "A loja está fechada. Atualize o status antes de pedir.",
  STORE_NOT_CONFIGURED: "A loja ainda não está pronta para receber pedidos.",
  TENANT_NOT_ACTIVE: "A loja está indisponível para novos pedidos.",
  ORDER_PRICE_CHANGED:
    "O preço mudou. Solicite uma nova cotação e confirme o novo total.",
  ORDER_INVALID:
    "Revise os itens, endereço, forma de pagamento, pedido mínimo e troco.",
  VALIDATION_FAILED: "Confira os campos preenchidos.",
  ADDRESS_LIMIT_REACHED: "Sua conta já tem 10 endereços.",
  LEGAL_VERSION_OUTDATED:
    "Os termos de uso ou a política de privacidade mudaram. Leia a versão atual e aceite novamente.",
  LEGAL_DOCUMENTS_UNAVAILABLE:
    "A loja ainda não publicou os termos de uso e a política de privacidade.",
  IDEMPOTENCY_CONFLICT:
    "Esta confirmação precisa ser conferida com a loja antes de tentar outro pedido.",
};
export function customerMessage(error: unknown): string {
  if (error instanceof CustomerError)
    return (
      messages[error.code] ??
      (error.status === 401
        ? messages.LOGIN_REQUIRED!
        : "Não foi possível concluir. Atualize os dados e tente novamente.")
    );
  return error instanceof Error
    ? error.message
    : "Não foi possível concluir a operação.";
}
