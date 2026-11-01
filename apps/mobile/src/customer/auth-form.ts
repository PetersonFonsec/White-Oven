import { normalizeCustomerPhone } from "./registration.ts";

/**
 * Client-side checks of the sign-in and sign-up form. They only say early what the API would
 * refuse anyway, next to the field; the API stays the authority (ADR 0017). Pure, for tests.
 */
export type AuthMode = "login" | "register";
export type AuthField = "name" | "phone" | "email" | "password" | "legal";
export type AuthErrors = Partial<Record<AuthField, string>>;

export interface AuthValues {
  name: string;
  phone: string;
  email: string;
  password: string;
  accepted: boolean;
}

export const PASSWORD_MIN = 10;
/** Order of the fields on screen: the first error gets the focus. */
export const AUTH_FIELD_ORDER: readonly AuthField[] = [
  "name",
  "phone",
  "email",
  "password",
  "legal",
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAuthForm(
  mode: AuthMode,
  values: AuthValues,
  legalReady: boolean,
): AuthErrors {
  const errors: AuthErrors = {};
  const email = values.email.trim();
  if (!email) errors.email = "Informe seu e-mail.";
  else if (!EMAIL.test(email))
    errors.email = "Confira o e-mail, por exemplo voce@exemplo.com.";
  if (!values.password) errors.password = "Informe sua senha.";
  if (mode === "login") return errors;

  if (!values.name.trim()) errors.name = "Informe seu nome.";
  if (values.phone.trim()) {
    const phone = normalizeCustomerPhone(values.phone);
    if (!phone || !/^\+\d{10,15}$/.test(phone))
      errors.phone = "Use DDD e número, por exemplo (11) 99999-9999.";
  }
  if (values.password && values.password.length < PASSWORD_MIN)
    errors.password = `A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`;
  if (!legalReady)
    errors.legal =
      "Os termos da pizzaria ainda não foram carregados. Tente carregar de novo.";
  else if (!values.accepted)
    errors.legal =
      "Para criar a conta, aceite os termos de uso e a política de privacidade.";
  return errors;
}

/** The first field with an error, in screen order, to move the focus there. */
export function firstError(errors: AuthErrors): AuthField | null {
  return AUTH_FIELD_ORDER.find((field) => errors[field]) ?? null;
}

/** One sentence for VoiceOver after a refused submit. */
export function errorSummary(errors: AuthErrors): string | null {
  const count = AUTH_FIELD_ORDER.filter((field) => errors[field]).length;
  if (!count) return null;
  return count === 1
    ? "Há 1 campo para corrigir."
    : `Há ${count} campos para corrigir.`;
}
