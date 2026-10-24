import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { SqliteLeadStore } from "../src/server/lead-store.ts";
import { registerHealth, healthResponse } from "../src/server/health.ts";
import { getCaptureConfig } from "../src/server/config.ts";
import { validateDeployment } from "../scripts/validate-deployment.mjs";
import {
  backupDatabase,
  restoreDatabase,
  initializeLedger,
  excludeFromRestore,
  verifyBackup,
} from "../scripts/storage.mjs";
const config = (path, enabled = "true") =>
  getCaptureConfig({
    LEADS_ENABLED: enabled,
    LEADS_DB_PATH: path,
    SITE_ORIGIN: "http://localhost:4321",
    LEADS_CONTROLLER_NAME: "Synthetic Controller",
    LEADS_PRIVACY_EMAIL: "privacy@example.test",
  });
test("health is read-only, distinguishes disabled, invalid, unhealthy and draining without exposing configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whiteoven-health-"));
  const path = join(dir, "leads.sqlite");
  const store = new SqliteLeadStore(path);
  try {
    const drain = registerHealth(() => config(path), store, true);
    const before = readFileSync(path);
    const response = healthResponse(false);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ready: true,
      capture: "enabled",
      storage: "ready",
    });
    assert.deepEqual(readFileSync(path), before);
    drain();
    assert.equal(healthResponse(false).status, 503);
    assert.equal(healthResponse(true).status, 200);
    registerHealth(() => config(path, "false"), undefined, false);
    assert.equal(healthResponse(false).status, 200);
    assert.deepEqual(await healthResponse(false).json(), {
      ready: true,
      capture: "disabled",
      storage: "unavailable",
    });
    registerHealth(() => config(path), undefined, true);
    assert.equal(healthResponse(false).status, 503);
    assert.doesNotMatch(
      await healthResponse(false).text(),
      /sqlite|Controller|privacy@example/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("deployment configuration validates safe defaults and rejects incomplete capture without logging values", () => {
  const env = {
    WHITEOVEN_IMAGE: "whiteoven:local",
    LEADS_ENABLED: "false",
    SITE_ORIGIN: "https://landing.example.invalid",
  };
  assert.equal(validateDeployment(env), true);
  assert.throws(() => validateDeployment({ ...env, LEADS_ENABLED: "true" }));
  assert.throws(() => validateDeployment({ ...env, WHITEOVEN_PORT: "22" }));
  assert.equal(
    validateDeployment({
      ...env,
      SITE_ORIGIN: "https://whiteoven.synthetic.test",
      LEADS_ENABLED: "true",
      LEADS_CONTROLLER_NAME: "Synthetic Controller",
      LEADS_PRIVACY_EMAIL: "privacy@example.test",
      LEADS_TRUSTED_PROXIES: "172.30.87.3",
    }),
    true,
  );
});
test("online backup is consistent, integrity checked, expired copies rejected, restore reapplies exclusions and keeps safety copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whiteoven-backup-"));
  const path = join(dir, "leads.sqlite");
  const backups = join(dir, "backups");
  const store = new SqliteLeadStore(path);
  try {
    const input = {
      responsibleName: "Synthetic",
      pizzeriaName: "Synthetic",
      whatsapp: "+5511999999999",
      monthlyOrderVolume: "UP_TO_300",
      interestedPlan: "FLEX",
      contactConsent: true,
      consentVersion: config(path).policy.version,
      attribution: {},
      funnel: {},
      website: "",
    };
    const saved = store.save(
      input,
      crypto.randomUUID(),
      config(path).policy,
      Date.now(),
    );
    initializeLedger(backups);
    await backupDatabase(path, backups, "first");
    assert.equal(statSync(join(backups, "first.sqlite")).mode & 0o077, 0);
    assert.equal(
      await backupDatabase(path, backups, "first"),
      join(backups, "first.sqlite"),
    );
    excludeFromRestore(backups, saved.lead.id.toUpperCase());
    const second = store.save(
      { ...input, pizzeriaName: "Another" },
      crypto.randomUUID(),
      config(path).policy,
      Date.now(),
    );
    store.close();
    await restoreDatabase(path, backups, "first");
    const restored = new Database(path, { readonly: true });
    assert.equal(
      restored.prepare("SELECT COUNT(*) AS n FROM leads").get().n,
      0,
    );
    restored.close();
    const { readdirSync } = await import("node:fs");
    const safety = readdirSync(backups).find(
      (name) => name.startsWith("before-restore-") && name.endsWith(".sqlite"),
    );
    assert.ok(safety);
    const previous = new Database(join(backups, safety), { readonly: true });
    assert.equal(
      previous.prepare("SELECT id FROM leads WHERE id = ?").get(second.lead.id)
        .id,
      second.lead.id,
    );
    previous.close();
    const meta = join(backups, "first.sqlite.json");
    const value = JSON.parse(readFileSync(meta, "utf8"));
    value.expiresAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(meta, JSON.stringify(value));
    assert.throws(() => verifyBackup(backups, "first"));
  } finally {
    try {
      store.close();
    } catch {
      /* already closed before offline restore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
