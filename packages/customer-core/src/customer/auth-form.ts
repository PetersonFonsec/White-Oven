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

/** The API's minimum (`PASSWORD_MIN_LENGTH`), counted in characters like the API does. */
export const PASSWORD_MIN = 10;
/** Order of the fields on screen: the first error gets the focus. */
export const AUTH_FIELD_ORDER: readonly AuthField[] = [
  "name",
  "email",
  "phone",
  "password",
  "legal",
];

export type PasswordRuleId = "length" | "uppercase" | "number";
export interface PasswordRule {
  id: PasswordRuleId;
  label: string;
  met: boolean;
}

/**
 * The rules listed under the new password while it is typed. The length is the API's rule; the
 * capital letter and the number are asked by the app only, so a new password is harder to guess.
 * The API still refuses common passwords on its own.
 */
export function passwordRules(password: string): PasswordRule[] {
  return [
    {
      id: "length",
      label: `Pelo menos ${PASSWORD_MIN} caracteres`,
      met: [...password].length >= PASSWORD_MIN,
    },
    {
      id: "uppercase",
      label: "Uma letra maiúscula",
      // Any letter with a lowercase form; plain JS, so Hermes needs no Unicode property escapes.
      met: password.toLowerCase() !== password,
    },
    { id: "number", label: "Um número", met: /\d/.test(password) },
  ];
}

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
  if (values.password) {
    const missing = passwordRules(values.password).filter((rule) => !rule.met);
    if (missing.length)
      errors.password = `A senha precisa ter: ${missing
        .map((rule) => rule.label.toLowerCase())
        .join(", ")}.`;
  }
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
