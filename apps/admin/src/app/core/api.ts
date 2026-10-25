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
};

/** A message in Portuguese for the person; never the API's English text. */
export function errorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code && MESSAGES[code]) return MESSAGES[code];
  if (error instanceof HttpErrorResponse && error.status === 0)
    return "Não foi possível falar com o servidor. Verifique a conexão.";
  return "Algo deu errado. Tente de novo.";
}
