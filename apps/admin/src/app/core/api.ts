import { HttpErrorResponse } from "@angular/common/http";

/** Every API route lives under `/v1`, served on the panel's own origin (proxy in development). */
export const API = "/v1";

export const AUTH = {
  login: `${API}/admin/auth/login`,
  loginMfa: `${API}/admin/auth/login/mfa`,
  refresh: `${API}/admin/auth/refresh`,
  logout: `${API}/admin/auth/logout`,
  tenants: `${API}/admin/auth/tenants`,
  activeTenant: `${API}/admin/auth/active-tenant`,
  mfaSetup: `${API}/admin/auth/mfa/setup`,
  mfaActivate: `${API}/admin/auth/mfa/activate`,
  adminMe: `${API}/admin/me`,
  platformMe: `${API}/platform/me`,
} as const;

/** Routes that authenticate by credentials or by the refresh cookie, never by bearer token. */
export const CREDENTIAL_ROUTES: readonly string[] = [
  AUTH.login,
  AUTH.loginMfa,
  AUTH.refresh,
  AUTH.logout,
];

/** The API's standard error body (ADR 0004). */
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
}

export function apiErrorCode(error: unknown): string | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const body = error.error as Partial<ApiErrorBody> | null;
  return typeof body?.code === "string" ? body.code : null;
}

/** The `{ code, path }` list some 422 responses carry in `details.errors`. */
export function apiFieldErrors(
  error: unknown,
): { code: string; path: string }[] {
  if (!(error instanceof HttpErrorResponse)) return [];
  const errors = (error.error as { details?: { errors?: unknown } } | null)
    ?.details?.errors;
  return Array.isArray(errors)
    ? errors.filter(
        (item): item is { code: string; path: string } =>
          typeof item?.code === "string" && typeof item?.path === "string",
      )
    : [];
}

/** HTTP status of an API failure; 0 when the API could not be reached, null for other errors. */
export function apiStatus(error: unknown): number | null {
  return error instanceof HttpErrorResponse ? error.status : null;
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: "E-mail ou senha incorretos.",
  RATE_LIMITED: "Muitas tentativas. Aguarde alguns minutos e tente de novo.",
  MFA_INVALID: "Código inválido. Confira o aplicativo autenticador.",
  MFA_CHALLENGE_INVALID: "A verificação expirou. Entre de novo.",
  SESSION_INVALID: "Sua sessão terminou. Entre de novo.",
  TENANT_ACCESS_DENIED: "Você não tem mais acesso a esta loja.",
  NOT_FOUND: "Você não tem mais acesso a esta loja.",
  VALIDATION_FAILED: "Confira os campos e tente de novo.",
  MFA_ALREADY_ENABLED: "A verificação em duas etapas já está ativa.",
  MFA_SETUP_REQUIRED: "Gere um novo código de configuração e tente de novo.",
  TENANT_SLUG_TAKEN: "Esse identificador já está em uso. Escolha outro.",
  TENANT_STATUS_CONFLICT:
    "A situação da pizzaria mudou. Atualize a lista e tente de novo.",
  IDEMPOTENCY_CONFLICT:
    "Os dados do cadastro mudaram durante a tentativa. Envie novamente.",
  ORDER_STATE_CONFLICT:
    "Outra pessoa atualizou este pedido. O quadro foi recarregado; confira o estado atual.",
  IDEMPOTENCY_KEY_REUSED:
    "Este comando já foi usado com outra ação. Atualize o pedido e tente novamente.",
  TENANT_NOT_ACTIVE: "A loja está suspensa e não permite essa transição.",
  RESOURCE_CONFLICT: "Já existe um cadastro com esses dados.",
  TENANT_NOT_FOUND: "Essa pizzaria não está mais disponível.",
  ADMIN_ORIGIN_NOT_CONFIGURED:
    "O envio de convite não está configurado neste ambiente.",
  INVITE_INVALID: "Este convite é inválido ou expirou.",
  OWNER_ACCOUNT_EXISTS: "Já existe uma conta com este e-mail.",
  OPENING_HOURS_INVALID: "Confira os horários destacados.",
  STORE_WRITE_FORBIDDEN:
    "As configurações não podem ser alteradas na situação atual da loja.",
  CATALOG_WRITE_FORBIDDEN:
    "O cardápio não pode ser alterado na situação atual da loja.",
  ROLE_FORBIDDEN: "Seu papel na loja não permite esta ação.",
  ALREADY_MEMBER: "Esta pessoa já faz parte da equipe da loja.",
  LAST_OWNER:
    "A loja precisa de pelo menos um dono. Promova outra pessoa a dono antes.",
  TEAM_WRITE_FORBIDDEN:
    "A equipe não pode ser alterada na situação atual da loja.",
  MEMBER_NOT_FOUND:
    "Esta pessoa não faz mais parte da equipe. Atualize a lista.",
  INVITE_NOT_FOUND: "Este convite não está mais pendente. Atualize a lista.",
  ACCOUNT_EXISTS:
    "Já existe uma conta com este e-mail. Entre com ela para aceitar o convite.",
  INVITE_EMAIL_MISMATCH:
    "Este convite é para outro e-mail. Saia e entre com a conta convidada.",
};

/** A message in Portuguese for the person; never the API's English text. */
export function errorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (error instanceof HttpErrorResponse && error.status === 0)
    return "Não foi possível falar com o servidor. Verifique a conexão.";
  return "Algo deu errado. Tente de novo.";
}
