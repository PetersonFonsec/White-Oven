import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateLeadSubmission,
  normalizeBrazilianWhatsapp,
  CONSENT_VERSION,
} from "@whiteoven/contracts";
import { getCaptureConfig } from "../src/server/config.ts";
import {
  SqliteLeadStore,
  IDEMPOTENCY_TTL_MS,
  DEDUPLICATION_MS,
} from "../src/server/lead-store.ts";
import {
  createLeadHandler,
  SubmissionLimiter,
} from "../src/server/lead-handler.ts";
const fixture = () => ({
  responsibleName: "Pessoa de Teste",
  pizzeriaName: "Pizzaria de Teste",
  whatsapp: "(11) 99999-9999",
  monthlyOrderVolume: "UP_TO_300",
  interestedPlan: "FLEX",
  contactConsent: true,
  consentVersion: CONSENT_VERSION,
  attribution: {
    utm_source: "teste",
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    referrer: "https://example.org/path?private=yes",
    landingPath: "/",
  },
  funnel: { pizzaBuilderInteracted: true, planCtaClicked: true },
  website: "",
});
const config = () =>
  getCaptureConfig({
    LEADS_ENABLED: "true",
    SITE_ORIGIN: "http://localhost:4321",
    LEADS_CONTROLLER_NAME: "Controlador de teste",
    LEADS_PRIVACY_EMAIL: "privacy@example.test",
  });
const valid = () => {
  const result = validateLeadSubmission(fixture());
  assert.equal(result.valid, true);
  return result.value;
};
const request = (body = fixture(), key = randomUUID(), headers = {}) =>
  new Request("http://localhost:4321/api/leads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:4321",
      "Idempotency-Key": key,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("domain validates, normalizes WhatsApp and minimizes referrer", () => {
  const lead = valid();
  assert.equal(lead.whatsapp, "+5511999999999");
  assert.equal(lead.attribution.referrer, "https://example.org");
  assert.equal(
    normalizeBrazilianWhatsapp("+55 (11) 99999-9999"),
    lead.whatsapp,
  );
  assert.equal(normalizeBrazilianWhatsapp("+1 202 555 0123"), null);
  assert.equal(normalizeBrazilianWhatsapp("00999999999"), null);
  for (const plan of ["FLEX", "PRO", "UNDECIDED"])
    assert.equal(
      validateLeadSubmission({ ...fixture(), interestedPlan: plan }).valid,
      true,
    );
});
for (const [name, change] of Object.entries({
  plan: { interestedPlan: "FREE" },
  volume: { monthlyOrderVolume: "free" },
  consent: { contactConsent: false },
  whatsapp: { whatsapp: "123" },
  largeName: { responsibleName: "a".repeat(101) },
  largePizzeria: { pizzeriaName: "a".repeat(151) },
  html: { responsibleName: "<script>x</script>" },
  extra: { unexpected: true },
  version: { consentVersion: "old" },
  honeypot: { website: "spam" },
  attribution: {
    attribution: { ...fixture().attribution, utm_source: "a".repeat(101) },
  },
})) {
  test(`domain rejects ${name}`, () =>
    assert.equal(
      validateLeadSubmission({ ...fixture(), ...change }).valid,
      false,
    ));
}
test("configuration fails closed without identity, activation, valid origin or production storage", () => {
  assert.equal(getCaptureConfig({}).enabled, false);
  assert.equal(getCaptureConfig({ LEADS_ENABLED: "true" }).enabled, false);
  const env = {
    LEADS_ENABLED: "true",
    LEADS_CONTROLLER_NAME: "Test Owner",
    LEADS_PRIVACY_EMAIL: "privacy@example.test",
    SITE_ORIGIN: "https://example.test",
  };
  assert.equal(getCaptureConfig(env).enabled, true);
  assert.equal(
    getCaptureConfig({ ...env, SITE_ORIGIN: "http://example.test" }).enabled,
    false,
  );
  assert.equal(
    getCaptureConfig({ ...env, NODE_ENV: "production" }).enabled,
    false,
  );
});
test("endpoint commits real data, idempotency survives restart and expires, duplicates are temporary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "whiteoven-leads-"));
  const path = join(directory, "test.sqlite");
  let store = new SqliteLeadStore(path);
  try {
    let now = Date.now();
    const key = randomUUID();
    const handler = createLeadHandler(
      config,
      () => store,
      new SubmissionLimiter(1000),
      () => now,
    );
    const response = await handler(request(fixture(), key));
    assert.equal(response.status, 201);
    const reply = await response.json();
    assert.equal(reply.ok, true);
    let saved = store.exportLeads(now);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, reply.leadId);
    assert.equal(saved[0].consentPolicy.text, config().policy.text);
    assert.equal(saved[0].contactConsent, true);
    assert.equal(saved[0].whatsapp, "+5511999999999");
    assert.equal(saved[0].attribution.utm_source, "teste");
    assert.equal("website" in saved[0], false);
    assert.equal("ip" in saved[0], false);
    store.close();
    store = new SqliteLeadStore(path);
    assert.equal((await handler(request(fixture(), key))).status, 200);
    assert.equal((await handler(request())).status, 200);
    assert.equal(
      (await handler(request({ ...fixture(), interestedPlan: "PRO" }, key)))
        .status,
      409,
    );
    assert.equal(store.exportLeads(now).length, 1);
    now += DEDUPLICATION_MS + 1;
    assert.equal((await handler(request())).status, 201);
    now += IDEMPOTENCY_TTL_MS + 1;
    assert.equal(
      (await handler(request({ ...fixture(), interestedPlan: "PRO" }, key)))
        .status,
      201,
    );
    saved = store.exportLeads(now);
    assert.equal(saved.length, 3);
    assert.equal(store.deleteLead(saved[0].id), true);
    assert.equal(store.exportLeads(now).length, 2);
    assert.equal(store.purgeExpired(now + 181 * 86400000), 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("endpoint rejects malformed, invalid, spam, oversized, foreign origin and unsupported method", async () => {
  const store = new SqliteLeadStore(":memory:");
  try {
    const handler = createLeadHandler(config, () => store);
    for (const [body, status] of [
      ["{", 400],
      [{ ...fixture(), whatsapp: "invalid" }, 422],
      [{ ...fixture(), website: "spam" }, 422],
      ["x".repeat(8193), 413],
      [{ ...fixture(), secret: "unexpected" }, 422],
    ])
      assert.equal((await handler(request(body))).status, status);
    assert.equal(
      (
        await handler(
          request(fixture(), randomUUID(), { Origin: "https://evil.test" }),
        )
      ).status,
      403,
    );
    assert.equal((await handler(request(fixture(), "invalid"))).status, 400);
    assert.equal(
      (
        await handler(
          request(fixture(), randomUUID(), { "Content-Type": "text/plain" }),
        )
      ).status,
      415,
    );
    assert.equal(
      (
        await handler(
          new Request("http://localhost:4321/api/leads", { method: "DELETE" }),
        )
      ).status,
      405,
    );
    assert.equal(store.exportLeads().length, 0);
  } finally {
    store.close();
  }
});
test("endpoint handles persistence failure safely, disabled config and rate-limit recovery", async () => {
  const broken = createLeadHandler(config, () => ({
    save() {
      throw new Error("private phone 11999999999 and SQL stack");
    },
  }));
  const response = await broken(request());
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /11999999999|SQL|stack/);
  const disabled = createLeadHandler(
    () => ({ ...config(), enabled: false }),
    () => {
      throw new Error("must not access storage");
    },
  );
  assert.equal((await disabled(request())).status, 503);
  assert.equal(
    (
      await (
        await disabled(new Request("http://localhost:4321/api/leads"))
      ).json()
    ).available,
    false,
  );
  const limiter = new SubmissionLimiter(1, 1000);
  assert.equal(limiter.allow(10000), true);
  assert.equal(limiter.allow(10001), false);
  assert.equal(limiter.allow(11000), true);
});

test("analytics can be disabled or fail without breaking callers; events whitelist properties", async () => {
  const { setAnalyticsAdapter, track } =
    await import("../src/scripts/analytics.ts");
  setAnalyticsAdapter(null);
  assert.doesNotThrow(() => track("landing_view"));
  setAnalyticsAdapter(() => {
    throw new Error("adapter unavailable");
  });
  assert.doesNotThrow(() => track("lead_form_error"));
  const events = [];
  setAnalyticsAdapter((event) => events.push(event));
  track("lead_form_success", "PRO");
  track("invalid", "PRIVATE_DATA");
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ["name", "pageId", "plan"]);
  setAnalyticsAdapter(null);
});

test("operator CLI exports restricted JSON without PII stdout and guards destructive cleanup", async () => {
  const { spawnSync } = await import("node:child_process");
  const { readFileSync, statSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "whiteoven-cli-"));
  const path = join(directory, "leads.dev.sqlite");
  try {
    const store = new SqliteLeadStore(path);
    const saved = store.save(
      valid(),
      randomUUID(),
      config().policy,
      Date.now(),
    );
    store.close();
    const run = (...args) =>
      spawnSync(
        process.execPath,
        ["--experimental-strip-types", "scripts/leads.mjs", ...args],
        {
          env: { ...process.env, NODE_ENV: "test", LEADS_DB_PATH: path },
          encoding: "utf8",
        },
      );
    const inspect = run("inspect");
    assert.equal(inspect.status, 0);
    assert.doesNotMatch(inspect.stdout, /Pessoa de Teste|99999/);
    const output = join(directory, "lead-exports", "test.json");
    assert.equal(run("export", output).status, 0);
    assert.equal(statSync(output).mode & 0o077, 0);
    assert.equal(JSON.parse(readFileSync(output, "utf8"))[0].id, saved.lead.id);
    assert.equal(run("export", output).status, 1);
    assert.equal(run("clear-dev").status, 1);
    assert.equal(run("delete", saved.lead.id).status, 0);
    assert.equal(run("purge").status, 0);
    assert.equal(run("clear-dev", "--confirm").status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
