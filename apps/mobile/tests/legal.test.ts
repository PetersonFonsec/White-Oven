import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  acceptedVersions,
  legalPageUrl,
  loadStoreLegal,
  parseStoreLegal,
} from "../src/customer/legal.ts";

const doc = (kind: string, version: string) => ({
  kind,
  version,
  body: "## Título\n\nTexto.",
  publishedAt: "2026-11-01T12:00:00.000Z",
});
const both = {
  privacyPolicy: doc("PRIVACY_POLICY", "p1"),
  termsOfUse: doc("TERMS_OF_USE", "t1"),
};

describe("store legal documents (ADR 0030)", () => {
  it("needs both documents for sign-up and refuses a malformed answer", () => {
    const legal = parseStoreLegal(both);
    assert.deepEqual(acceptedVersions(legal!), {
      privacyPolicyVersion: "p1",
      termsOfUseVersion: "t1",
    });
    assert.equal(parseStoreLegal({ ...both, termsOfUse: null }), null);
    assert.equal(parseStoreLegal({}), null);
    for (const bad of [
      null,
      "x",
      { ...both, termsOfUse: doc("PRIVACY_POLICY", "t1") },
      { ...both, privacyPolicy: { ...both.privacyPolicy, version: "a b" } },
      { ...both, privacyPolicy: { ...both.privacyPolicy, body: " " } },
      { ...both, privacyPolicy: { ...both.privacyPolicy, publishedAt: "x" } },
    ])
      assert.throws(() => parseStoreLegal(bad));
  });

  it("loads from the store's public route and reports every failure as a state", async () => {
    const asked: string[] = [];
    const answer =
      (status: number, body: unknown): typeof fetch =>
      async (url) => {
        asked.push(String(url));
        return new Response(JSON.stringify(body), { status });
      };
    const options = {
      apiUrl: "https://api.example.com",
      storeSlug: "pizzaria-centro",
    };
    const ready = await loadStoreLegal({
      ...options,
      fetch: answer(200, both),
    });
    assert.equal(ready.status, "ready");
    assert.deepEqual(asked, [
      "https://api.example.com/v1/public/stores/pizzaria-centro/legal",
    ]);
    assert.deepEqual(
      await loadStoreLegal({
        ...options,
        fetch: answer(200, { privacyPolicy: null, termsOfUse: null }),
      }),
      { status: "unavailable" },
    );
    assert.deepEqual(
      await loadStoreLegal({ ...options, fetch: answer(503, {}) }),
      { status: "error" },
    );
    assert.deepEqual(
      await loadStoreLegal({
        ...options,
        fetch: answer(200, { privacyPolicy: 1 }),
      }),
      { status: "error" },
    );
    assert.deepEqual(
      await loadStoreLegal({
        ...options,
        fetch: async () => {
          throw new TypeError("offline");
        },
      }),
      { status: "error" },
    );
    assert.equal(
      legalPageUrl(options.apiUrl, options.storeSlug, "excluir-conta"),
      "https://api.example.com/lojas/pizzaria-centro/excluir-conta",
    );
  });
});
