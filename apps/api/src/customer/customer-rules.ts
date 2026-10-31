import { passwordProblem } from "../auth/password";

/**
 * Customer account rules (docs/architecture/domain-model.md#customer, M4.2). Pure functions: the
 * API validates every body with them and reports the offending paths, never the values.
 */

export type RuleResult<T> =
  { ok: true; value: T } | { ok: false; paths: string[] };

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Missing required keys, then unknown keys, as paths. */
function keyIssues(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): string[] {
  const allowed = [...required, ...optional];
  return [
    ...required.filter((key) => !Object.hasOwn(value, key)),
    ...Object.keys(value)
      .filter((key) => !allowed.includes(key))
      .sort(),
  ];
}

const EMAIL = /^[^\s@]{1,64}@[a-z0-9.-]{1,189}\.[a-z]{2,}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
export const CUSTOMER_NAME_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;
export const POLICY_VERSION_MAX_LENGTH = 40;
export const ADDRESSES_PER_CUSTOMER_MAX = 10;

/** Trimmed and lower-cased, as stored and compared (unique per tenant). */
export const normalizeEmail = (value: string) => value.trim().toLowerCase();

/** A trimmed string of 1..max characters, or null when not one. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && [...trimmed].length <= max ? trimmed : null;
}

/** Null, blank (stored as null) or a trimmed string of up to `max` characters. */
function optionalText(
  value: unknown,
  max: number,
): { ok: true; value: string | null } | { ok: false } {
  if (value === null || (typeof value === "string" && !value.trim()))
    return { ok: true, value: null };
  const parsed = text(value, max);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

/** The versions of the store's legal documents the app showed and the customer accepted. */
export interface LegalVersions {
  privacyPolicyVersion: string;
  termsOfUseVersion: string;
}

export interface Registration extends LegalVersions {
  name: string;
  email: string;
  password: string;
  phone: string | null;
}

const LEGAL_KEYS = ["privacyPolicyVersion", "termsOfUseVersion"] as const;

function legalVersions(
  raw: Record<string, unknown>,
  paths: string[],
): LegalVersions {
  const [privacy, terms] = LEGAL_KEYS.map((key) => {
    const version = text(raw[key], POLICY_VERSION_MAX_LENGTH);
    if (version === null) paths.push(key);
    return version ?? "";
  });
  return { privacyPolicyVersion: privacy!, termsOfUseVersion: terms! };
}

/** `POST me/legal-acceptances` (ADR 0030): exactly the two current versions. */
export function validateLegalAcceptance(
  raw: unknown,
): RuleResult<LegalVersions> {
  if (!plain(raw)) return { ok: false, paths: [""] };
  const paths = keyIssues(raw, LEGAL_KEYS);
  const versions = legalVersions(raw, paths);
  if (paths.length) return { ok: false, paths: [...new Set(paths)] };
  return { ok: true, value: versions };
}

export function validateRegistration(raw: unknown): RuleResult<Registration> {
  if (!plain(raw)) return { ok: false, paths: [""] };
  const paths = keyIssues(
    raw,
    ["name", "email", "password", ...LEGAL_KEYS],
    ["phone"],
  );
  const name = text(raw["name"], CUSTOMER_NAME_MAX_LENGTH);
  if (name === null) paths.push("name");
  const email =
    typeof raw["email"] === "string" ? normalizeEmail(raw["email"]) : "";
  if (!EMAIL.test(email) || email.length > EMAIL_MAX_LENGTH)
    paths.push("email");
  const password = raw["password"];
  if (typeof password !== "string" || passwordProblem(password))
    paths.push("password");
  const phoneRaw = raw["phone"] ?? null;
  const phone =
    phoneRaw === null || (typeof phoneRaw === "string" && !phoneRaw.trim())
      ? null
      : typeof phoneRaw === "string" && PHONE.test(phoneRaw.trim())
        ? phoneRaw.trim()
        : undefined;
  if (phone === undefined) paths.push("phone");
  const versions = legalVersions(raw, paths);
  if (paths.length) return { ok: false, paths: [...new Set(paths)] };
  return {
    ok: true,
    value: {
      name: name!,
      email,
      password: password as string,
      phone: phone!,
      ...versions,
    },
  };
}

export interface CustomerAddress {
  label: string;
  /** Brazilian CEP, digits only. */
  postalCode: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  city: string;
  /** UF, two upper-case letters. */
  state: string;
  reference: string | null;
}

const ADDRESS_TEXT = {
  label: 40,
  street: 120,
  number: 20,
  district: 80,
  city: 80,
} as const;
const ADDRESS_OPTIONAL = { complement: 60, reference: 120 } as const;
const CEP = /^(\d{5})-?(\d{3})$/;
const UF = /^[A-Za-z]{2}$/;

/** No geocoding (domain model): the address is only checked for shape. */
export function validateAddress(raw: unknown): RuleResult<CustomerAddress> {
  if (!plain(raw)) return { ok: false, paths: [""] };
  const required = [
    "label",
    "postalCode",
    "street",
    "number",
    "district",
    "city",
    "state",
  ];
  const paths = keyIssues(raw, required, ["complement", "reference"]);
  const fields: Record<string, string | null> = {};
  for (const [key, max] of Object.entries(ADDRESS_TEXT)) {
    const value = text(raw[key], max);
    if (value === null) paths.push(key);
    fields[key] = value;
  }
  for (const [key, max] of Object.entries(ADDRESS_OPTIONAL)) {
    const value = optionalText(raw[key] ?? null, max);
    if (!value.ok) paths.push(key);
    else fields[key] = value.value;
  }
  const cep =
    typeof raw["postalCode"] === "string"
      ? CEP.exec(raw["postalCode"].trim())
      : null;
  if (!cep) paths.push("postalCode");
  const state =
    typeof raw["state"] === "string" && UF.test(raw["state"].trim())
      ? raw["state"].trim().toUpperCase()
      : null;
  if (!state) paths.push("state");
  if (paths.length) return { ok: false, paths: [...new Set(paths)] };
  return {
    ok: true,
    value: {
      label: fields["label"]!,
      postalCode: `${cep![1]}${cep![2]}`,
      street: fields["street"]!,
      number: fields["number"]!,
      complement: fields["complement"] ?? null,
      district: fields["district"]!,
      city: fields["city"]!,
      state: state!,
      reference: fields["reference"] ?? null,
    },
  };
}
