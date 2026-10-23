/** Public wire contract. No database or runtime-specific dependencies. */
export const INTERESTED_PLANS = ["FLEX", "PRO", "UNDECIDED"] as const;
export const MONTHLY_ORDER_VOLUMES = [
  "UP_TO_300",
  "FROM_301_TO_1000",
  "FROM_1001_TO_3000",
  "OVER_3000",
] as const;
export type InterestedPlan = (typeof INTERESTED_PLANS)[number];
export type MonthlyOrderVolume = (typeof MONTHLY_ORDER_VOLUMES)[number];
export const CONSENT_VERSION = "2026-10-23.2";
export const CONTACT_CONSENT_TEXT =
  "Autorizo o contato da equipe WhiteOven pelo WhatsApp informado para conversar sobre meu interesse no produto, conforme a Política de Privacidade.";
export const RETENTION_DAYS = 180;
export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;
export interface Attribution {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  referrer: string | null;
  landingPath: "/";
}
export interface FunnelContext {
  pizzaBuilderInteracted: boolean;
  planCtaClicked: boolean;
}
export interface LeadSubmission {
  responsibleName: string;
  pizzeriaName: string;
  whatsapp: string;
  monthlyOrderVolume: MonthlyOrderVolume;
  interestedPlan: InterestedPlan;
  contactConsent: true;
  consentVersion: typeof CONSENT_VERSION;
  attribution: Attribution;
  funnel: FunnelContext;
  website: string;
}
export interface ConsentPolicySnapshot {
  version: string;
  text: string;
  controllerName: string;
  privacyEmail: string;
  retentionDays: number;
}
export interface Lead extends Omit<LeadSubmission, "website"> {
  id: string;
  createdAt: string;
  expiresAt: string;
  consentPolicy: ConsentPolicySnapshot;
}
export type LeadField =
  | "responsibleName"
  | "pizzeriaName"
  | "whatsapp"
  | "monthlyOrderVolume"
  | "interestedPlan"
  | "contactConsent";
export type LeadFieldErrors = Partial<Record<LeadField, string>>;
export type LeadErrorCode =
  | "VALIDATION"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_CONFLICT"
  | "UNAVAILABLE";
export type LeadResponse =
  | { ok: true; leadId: string; createdAt: string }
  | {
      ok: false;
      code: LeadErrorCode;
      message: string;
      fields?: LeadFieldErrors;
    };
export type ValidationResult =
  | { valid: true; value: LeadSubmission }
  | { valid: false; fields: LeadFieldErrors; spam: boolean };
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const ddds = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35,
  37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64,
  65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88,
  89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);
export function normalizeBrazilianWhatsapp(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 25 ||
    !/^\+?[\d\s().-]+$/.test(value)
  )
    return null;
  let digits = value.replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55"))
    digits = digits.slice(2);
  if (value.startsWith("+") && !value.startsWith("+55")) return null;
  if (!ddds.has(Number(digits.slice(0, 2)))) return null;
  if (!/^(?:\d{2}9\d{8}|\d{2}[2-5]\d{7})$/.test(digits)) return null;
  return `+55${digits}`;
}
export function validateLeadSubmission(raw: unknown): ValidationResult {
  const fields: LeadFieldErrors = {};
  const fail = (spam = false): ValidationResult => ({
    valid: false,
    fields,
    spam,
  });
  if (
    !plain(raw) ||
    !exactKeys(raw, [
      "responsibleName",
      "pizzeriaName",
      "whatsapp",
      "monthlyOrderVolume",
      "interestedPlan",
      "contactConsent",
      "consentVersion",
      "attribution",
      "funnel",
      "website",
    ])
  )
    return fail();
  if (typeof raw.website !== "string" || raw.website.length > 0)
    return fail(true);
  const cleanName = (value: unknown, max: number): string | null => {
    if (
      typeof value !== "string" ||
      value.length > max ||
      // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted data.
      /[\u0000-\u001f\u007f<>]/u.test(value)
    )
      return null;
    const normalized = value.normalize("NFC").trim().replace(/\s+/g, " ");
    return normalized.length >= 2 ? normalized : null;
  };
  const responsibleName = cleanName(raw.responsibleName, 100);
  const pizzeriaName = cleanName(raw.pizzeriaName, 150);
  const whatsapp = normalizeBrazilianWhatsapp(raw.whatsapp);
  if (!responsibleName)
    fields.responsibleName = "Informe um nome entre 2 e 100 caracteres.";
  if (!pizzeriaName)
    fields.pizzeriaName =
      "Informe o nome da pizzaria entre 2 e 150 caracteres.";
  if (!whatsapp)
    fields.whatsapp = "Informe um WhatsApp brasileiro válido, com DDD.";
  if (
    !MONTHLY_ORDER_VOLUMES.includes(
      raw.monthlyOrderVolume as MonthlyOrderVolume,
    )
  )
    fields.monthlyOrderVolume = "Selecione uma faixa de pedidos.";
  if (!INTERESTED_PLANS.includes(raw.interestedPlan as InterestedPlan))
    fields.interestedPlan = "Selecione um plano de interesse válido.";
  if (raw.contactConsent !== true)
    fields.contactConsent = "Autorize o contato para enviar seu interesse.";
  if (
    Object.keys(fields).length ||
    !responsibleName ||
    !pizzeriaName ||
    !whatsapp
  )
    return fail();
  if (
    raw.consentVersion !== CONSENT_VERSION ||
    !plain(raw.attribution) ||
    !exactKeys(raw.attribution, [...UTM_KEYS, "referrer", "landingPath"]) ||
    !plain(raw.funnel) ||
    !exactKeys(raw.funnel, ["pizzaBuilderInteracted", "planCtaClicked"])
  )
    return fail();
  const attribution: Attribution = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    referrer: null,
    landingPath: "/",
  };
  for (const key of UTM_KEYS) {
    const value = raw.attribution[key];
    if (
      value !== null &&
      (typeof value !== "string" ||
        value.length > 100 ||
        // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted data.
        /[\u0000-\u001f\u007f<>]/u.test(value))
    )
      return fail();
    attribution[key] = typeof value === "string" ? value.trim() || null : null;
  }
  if (raw.attribution.landingPath !== "/") return fail();
  const referrer = raw.attribution.referrer;
  if (referrer !== null) {
    if (typeof referrer !== "string" || referrer.length > 300) return fail();
    try {
      const url = new URL(referrer);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return fail();
      attribution.referrer = url.origin;
    } catch {
      return fail();
    }
  }
  if (
    typeof raw.funnel.pizzaBuilderInteracted !== "boolean" ||
    typeof raw.funnel.planCtaClicked !== "boolean"
  )
    return fail();
  return {
    valid: true,
    value: {
      responsibleName,
      pizzeriaName,
      whatsapp,
      monthlyOrderVolume: raw.monthlyOrderVolume as MonthlyOrderVolume,
      interestedPlan: raw.interestedPlan as InterestedPlan,
      contactConsent: true,
      consentVersion: CONSENT_VERSION,
      attribution,
      funnel: {
        pizzaBuilderInteracted: raw.funnel.pizzaBuilderInteracted,
        planCtaClicked: raw.funnel.planCtaClicked,
      },
      website: "",
    },
  };
}
