import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDemonstrationLegalVersion,
  legalBlocks,
  legalDocumentProblems,
} from "@whiteoven/contracts";

test("splits headings, paragraphs and lists", () => {
  assert.deepEqual(
    legalBlocks(
      "## 1. Quem somos\r\nA pizzaria\ntrata seus dados.\n\n- nome\n- e-mail\n\n  \n## 2. Direitos\n\nVocê pode excluir a conta.",
    ),
    [
      { type: "heading", text: "1. Quem somos" },
      { type: "paragraph", text: "A pizzaria trata seus dados." },
      { type: "list", items: ["nome", "e-mail"] },
      { type: "heading", text: "2. Direitos" },
      { type: "paragraph", text: "Você pode excluir a conta." },
    ],
  );
});

test("keeps markup as text: renderers escape it", () => {
  assert.deepEqual(legalBlocks("<script>x</script>"), [
    { type: "paragraph", text: "<script>x</script>" },
  ]);
  assert.deepEqual(legalBlocks("- a\nb"), [
    { type: "paragraph", text: "- a b" },
  ]);
  assert.deepEqual(legalBlocks("   \n\n"), []);
});

test("validates a document to publish", () => {
  assert.deepEqual(
    legalDocumentProblems({
      kind: "PRIVACY_POLICY",
      version: "2026-11.1",
      body: "Texto",
    }),
    [],
  );
  assert.deepEqual(
    legalDocumentProblems({ kind: "COOKIES", version: "-x", body: "\n\n" }),
    ["kind", "version", "body"],
  );
  assert.deepEqual(
    legalDocumentProblems({
      kind: "TERMS_OF_USE",
      version: "v".repeat(41),
      body: "x".repeat(100_001),
    }),
    ["version", "body"],
  );
  assert.equal(isDemonstrationLegalVersion("demo-2026-10-27"), true);
  assert.equal(isDemonstrationLegalVersion("2026-11"), false);
});
