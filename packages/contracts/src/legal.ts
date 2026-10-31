/**
 * Legal documents of a store (M7.2, ADR 0030): the privacy policy and the terms of use the store
 * shows its customers. The text is written by the store's legal counsel and published by a
 * WhiteOven operator; the API keeps every version, and the app, the web pages and the panel all
 * render it through `legalBlocks`, so the customer reads the same structure everywhere.
 */
export const LEGAL_DOCUMENT_KINDS = ["PRIVACY_POLICY", "TERMS_OF_USE"] as const;
export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];

/** Same limit as `customers.privacy_policy_version` (M4.2). */
export const LEGAL_VERSION_MAX_LENGTH = 40;
export const LEGAL_BODY_MAX_LENGTH = 100_000;
/** Letters, digits, dot, underscore and hyphen, starting with a letter or digit. */
export const LEGAL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/**
 * Versions starting with `demo-` mark demonstration text (seed, development). A store build and
 * the onboarding checklist refuse them (ADR 0028, ADR 0030).
 */
export const isDemonstrationLegalVersion = (version: string) =>
  /^demo-/i.test(version);

export interface LegalDocument {
  kind: LegalDocumentKind;
  version: string;
  /** Plain text, see `legalBlocks`. */
  body: string;
  publishedAt: string;
}

/** What `GET /v1/public/stores/{slug}/legal` answers: the current version of each kind. */
export interface StoreLegalDocuments {
  privacyPolicy: LegalDocument | null;
  termsOfUse: LegalDocument | null;
}

export type LegalBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] };

/**
 * Splits a legal text into blocks. The format is deliberately small, so no renderer ever needs
 * HTML from the text: blocks are separated by a blank line; a block whose first line starts with
 * `## ` is a heading (any following lines form a paragraph after it); a block whose lines all
 * start with `- ` is a list; any other block is a paragraph whose lines are joined by a space.
 * Every renderer escapes the text it outputs.
 */
export function legalBlocks(body: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  const chunks = body
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    )
    .filter((lines) => lines.length > 0);
  for (const lines of chunks) {
    let rest = lines;
    const first = rest[0]!;
    if (first.startsWith("## ")) {
      const text = first.slice(3).trim();
      if (text) blocks.push({ type: "heading", text });
      rest = rest.slice(1);
      if (rest.length === 0) continue;
    }
    if (rest.every((line) => line.startsWith("- "))) {
      const items = rest
        .map((line) => line.slice(2).trim())
        .filter((item) => item !== "");
      if (items.length) blocks.push({ type: "list", items });
      continue;
    }
    blocks.push({ type: "paragraph", text: rest.join(" ") });
  }
  return blocks;
}

/** Problems of a document an operator wants to publish; empty means valid. */
export function legalDocumentProblems(input: {
  kind: unknown;
  version: unknown;
  body: unknown;
}): string[] {
  const problems: string[] = [];
  if (
    typeof input.kind !== "string" ||
    !(LEGAL_DOCUMENT_KINDS as readonly string[]).includes(input.kind)
  )
    problems.push("kind");
  if (
    typeof input.version !== "string" ||
    !LEGAL_VERSION_PATTERN.test(input.version)
  )
    problems.push("version");
  if (
    typeof input.body !== "string" ||
    input.body.length > LEGAL_BODY_MAX_LENGTH ||
    legalBlocks(input.body).length === 0
  )
    problems.push("body");
  return problems;
}
