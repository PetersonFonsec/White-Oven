import {
  LEGAL_BODY_MAX_LENGTH,
  LEGAL_VERSION_PATTERN,
  type LegalDocument,
  type LegalDocumentKind,
} from "@whiteoven/contracts";

/**
 * The store's privacy policy and terms of use (M7.2, ADR 0030), read from the API every time
 * the account screen needs them, never built into the binary. Sign-up sends the two versions
 * the customer was shown; the API refuses any other.
 */
export interface StoreLegal {
  privacyPolicy: LegalDocument;
  termsOfUse: LegalDocument;
}

export type LegalState =
  | { status: "loading" }
  /** The store has not published both documents yet: sign-up stays disabled. */
  | { status: "unavailable" }
  /** The API did not answer or answered something invalid. */
  | { status: "error" }
  | { status: "ready"; legal: StoreLegal };

function document(raw: unknown, kind: LegalDocumentKind): LegalDocument | null {
  const value = raw as Partial<LegalDocument> | null;
  if (
    !value ||
    value.kind !== kind ||
    typeof value.version !== "string" ||
    !LEGAL_VERSION_PATTERN.test(value.version) ||
    typeof value.body !== "string" ||
    !value.body.trim() ||
    value.body.length > LEGAL_BODY_MAX_LENGTH ||
    typeof value.publishedAt !== "string" ||
    Number.isNaN(Date.parse(value.publishedAt))
  )
    return null;
  return {
    kind,
    version: value.version,
    body: value.body,
    publishedAt: value.publishedAt,
  };
}

/** Parses `GET /v1/public/stores/{slug}/legal`; throws on a body that is not one. */
export function parseStoreLegal(raw: unknown): StoreLegal | null {
  const value = raw as Record<string, unknown> | null;
  if (!value || typeof value !== "object") throw new Error("INVALID_RESPONSE");
  const privacy = value["privacyPolicy"] ?? null;
  const terms = value["termsOfUse"] ?? null;
  const privacyPolicy =
    privacy === null ? null : document(privacy, "PRIVACY_POLICY");
  const termsOfUse = terms === null ? null : document(terms, "TERMS_OF_USE");
  if ((privacy !== null && !privacyPolicy) || (terms !== null && !termsOfUse))
    throw new Error("INVALID_RESPONSE");
  return privacyPolicy && termsOfUse ? { privacyPolicy, termsOfUse } : null;
}

export async function loadStoreLegal(options: {
  apiUrl: string;
  storeSlug: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<LegalState> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 10_000,
  );
  try {
    const response = await options.fetch(
      `${options.apiUrl}/v1/public/stores/${encodeURIComponent(options.storeSlug)}/legal`,
      { headers: { accept: "application/json" }, signal: controller.signal },
    );
    if (!response.ok) return { status: "error" };
    const legal = parseStoreLegal(await response.json());
    return legal ? { status: "ready", legal } : { status: "unavailable" };
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** The body of a sign-up or of `POST me/legal-acceptances`. */
export const acceptedVersions = (legal: StoreLegal) => ({
  privacyPolicyVersion: legal.privacyPolicy.version,
  termsOfUseVersion: legal.termsOfUse.version,
});

/** The store's web page for this document, the same text the app shows. */
export const legalPageUrl = (
  apiUrl: string,
  storeSlug: string,
  page: "privacidade" | "termos" | "excluir-conta",
) => `${apiUrl}/lojas/${encodeURIComponent(storeSlug)}/${page}`;
