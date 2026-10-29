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
  async function raw(
    path: string,
    method: string,
    body?: string,
    token?: string,
    key?: string,
  ): Promise<unknown> {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? 15000);
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
      throw new CustomerError(0, "NETWORK");
    } finally {
      clearTimeout(timeout);
    }
  }
  async function accept(value: unknown) {
    const next = tokens(value);
    await options.secret.write(next.refreshToken);
    access = next.accessToken;
    expires = now() + next.expiresIn * 1000 - 30000;
  }
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      access = null;
      const saved = await options.secret.read();
      if (!saved) throw new CustomerError(401, "LOGIN_REQUIRED");
      // Consume before rotation: a lost response must never replay a spent refresh token.
      await options.secret.remove();
      await accept(
        await raw(
          "auth/refresh",
          "POST",
          JSON.stringify({ refreshToken: saved }),
        ),
      );
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }
  return {
    get signedIn() {
      return access !== null;
    },
    async restore() {
      if (await options.secret.read()) await refresh();
    },
    async signIn(mode: "login" | "register", body: unknown) {
      access = null;
      await accept(await raw(`auth/${mode}`, "POST", JSON.stringify(body)));
    },
    async request(
      path: string,
      method = "GET",
      body?: unknown,
      key?: string,
    ): Promise<unknown> {
      if (!access || now() >= expires) await refresh();
      const sentToken = access!;
      const encoded =
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body);
      try {
        return await raw(path, method, encoded, sentToken, key);
      } catch (error) {
        if (!(error instanceof CustomerError) || error.status !== 401)
          throw error;
        // Concurrent 401s share one rotation, even when one response arrives late.
        if (access === sentToken || !access) await refresh();
        return raw(path, method, encoded, access!, key);
      }
    },
    async logout() {
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
      await options.secret.remove();
      access = null;
    },
  };
}
export type CustomerClient = ReturnType<typeof createCustomerClient>;

const messages: Record<string, string> = {
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
