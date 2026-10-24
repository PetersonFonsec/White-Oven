import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
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
  pruneExpiredBackups,
  importBundle,
  exportBundle,
  mergeLedger,
  dumpLedger,
  probeWrite,
} from "../scripts/storage.mjs";
import {
  resetWriteOutcome,
  WRITE_FAILURE_THRESHOLD,
} from "../src/server/persistence-health.ts";
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
  resetWriteOutcome();
  try {
    const drain = registerHealth(() => config(path), store, true);
    const before = readFileSync(path);
    const response = healthResponse(false);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ready: true,
      capture: "enabled",
      storage: "ready",
      writes: "unknown",
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
      writes: "unknown",
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

const submission = (policy) => ({
  responsibleName: "Synthetic",
  pizzeriaName: "Synthetic",
  whatsapp: "+5511999999999",
  monthlyOrderVolume: "UP_TO_300",
  interestedPlan: "FLEX",
  contactConsent: true,
  consentVersion: policy.version,
  attribution: {},
  funnel: {},
  website: "",
});
test("readiness reports failing writes from real submissions without writing itself", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whiteoven-writes-"));
  const path = join(dir, "leads.sqlite");
  const store = new SqliteLeadStore(path);
  const { policy } = config(path);
  resetWriteOutcome();
  try {
    registerHealth(() => config(path), store, true);
    store.save(submission(policy), crypto.randomUUID(), policy, Date.now());
    assert.equal((await healthResponse(false).json()).writes, "ok");
    // Simulate a database that still answers reads but rejects writes.
    const db = new Database(path);
    db.exec(
      "CREATE TRIGGER reject_writes BEFORE INSERT ON leads BEGIN SELECT RAISE(ABORT, 'disk'); END;",
    );
    db.close();
    for (let i = 1; i <= WRITE_FAILURE_THRESHOLD; i++) {
      assert.throws(() =>
        store.save(
          { ...submission(policy), pizzeriaName: `Synthetic ${i}` },
          crypto.randomUUID(),
          policy,
          Date.now(),
        ),
      );
      const expected = i < WRITE_FAILURE_THRESHOLD;
      assert.equal(healthResponse(false).status, expected ? 200 : 503);
    }
    const before = readFileSync(path);
    assert.deepEqual(await healthResponse(false).json(), {
      ready: false,
      capture: "enabled",
      storage: "ready",
      writes: "failing",
    });
    assert.deepEqual(readFileSync(path), before);
    // An idempotency conflict is a client error and must not count against storage.
    const fresh = new Database(path);
    fresh.exec("DROP TRIGGER reject_writes;");
    fresh.close();
    const key = crypto.randomUUID();
    store.save(submission(policy), key, policy, Date.now());
    assert.equal((await healthResponse(false).json()).writes, "ok");
    assert.throws(() =>
      store.save(
        { ...submission(policy), pizzeriaName: "Changed" },
        key,
        policy,
        Date.now(),
      ),
    );
    assert.equal((await healthResponse(false).json()).writes, "ok");
  } finally {
    store.close();
    resetWriteOutcome();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("explicit write probe uses a scratch file and leaves the leads database untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "whiteoven-probe-"));
  const path = join(dir, "leads.sqlite");
  const store = new SqliteLeadStore(path);
  try {
    store.close();
    const before = readFileSync(path);
    probeWrite(path);
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.startsWith(".write-probe")),
      [],
    );
    assert.throws(() => probeWrite(join(dir, "missing", "leads.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("backups are bound to their deletion ledger; a recreated ledger cannot resurrect deleted leads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whiteoven-ledger-"));
  const path = join(dir, "leads.sqlite");
  const backups = join(dir, "backups");
  const store = new SqliteLeadStore(path);
  const { policy } = config(path);
  try {
    const saved = store.save(
      submission(policy),
      crypto.randomUUID(),
      policy,
      Date.now(),
    );
    await assert.rejects(() => backupDatabase(path, backups, "no-ledger"));
    initializeLedger(backups);
    await backupDatabase(path, backups, "old");
    excludeFromRestore(backups, saved.lead.id);
    store.deleteLead(saved.lead.id);
    store.close();
    // Losing the ledger and starting a new one must not pair it with older copies.
    rmSync(join(backups, "deletions.json"));
    initializeLedger(backups);
    assert.throws(() => verifyBackup(backups, "old"), /LEDGER_MISMATCH/);
    await assert.rejects(
      () => restoreDatabase(path, backups, "old"),
      /LEDGER_MISMATCH/,
    );
    const db = new Database(path, { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leads").get().n, 0);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("expired backups are removed from the volume, valid ones kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whiteoven-prune-"));
  const path = join(dir, "leads.sqlite");
  const backups = join(dir, "backups");
  const store = new SqliteLeadStore(path);
  try {
    initializeLedger(backups);
    await backupDatabase(path, backups, "current");
    await backupDatabase(path, backups, "expired");
    const meta = join(backups, "expired.sqlite.json");
    const value = JSON.parse(readFileSync(meta, "utf8"));
    value.expiresAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(meta, JSON.stringify(value));
    writeFileSync(join(backups, "broken.sqlite.json"), "{");
    assert.equal(pruneExpiredBackups(backups), 2);
    assert.deepEqual(readdirSync(backups).sort(), [
      "current.sqlite",
      "current.sqlite.json",
      "deletions.json",
    ]);
    verifyBackup(backups, "current");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
// Simulates the new host: an empty backup volume, optionally with a fresh empty ledger.
async function exportedHost(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "leads.sqlite");
  const backups = join(dir, "backups");
  const store = new SqliteLeadStore(path);
  const { policy } = config(path);
  const lead = (name) =>
    store.save(
      { ...submission(policy), pizzeriaName: name },
      crypto.randomUUID(),
      policy,
      Date.now(),
    ).lead.id;
  const kept = lead("Kept");
  const removed = lead("Removed later");
  initializeLedger(backups);
  await backupDatabase(path, backups, "offsite");
  const bundle = exportBundle(backups, "offsite");
  return { dir, path, backups, store, bundle, kept, removed };
}
const leadIds = (path) => {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .prepare("SELECT id FROM leads ORDER BY id")
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }
};
test("bundle restores backup, metadata and ledger on a new host, including newer exclusions", async () => {
  const old = await exportedHost("whiteoven-dr-old-");
  const fresh = mkdtempSync(join(tmpdir(), "whiteoven-dr-new-"));
  try {
    // Deletion after the export: only a later ledger copy carries it.
    excludeFromRestore(old.backups, old.removed);
    old.store.deleteLead(old.removed);
    old.store.close();
    const laterLedger = dumpLedger(old.backups);
    const backups = join(fresh, "backups");
    const path = join(fresh, "leads.sqlite");
    // An operator who ran ledger-init first: empty, unused, so it is archived, not merged.
    initializeLedger(backups);
    const empty = JSON.parse(
      readFileSync(join(backups, "deletions.json"), "utf8"),
    );
    assert.equal(
      importBundle(old.bundle, backups, "offsite"),
      "replaced-empty",
    );
    assert.ok(
      existsSync(join(backups, `deletions.superseded-${empty.id}.json`)),
    );
    verifyBackup(backups, "offsite");
    assert.equal(statSync(join(backups, "offsite.sqlite")).mode & 0o077, 0);
    assert.equal(mergeLedger(backups, laterLedger), "merged");
    assert.equal(mergeLedger(backups, laterLedger), "unchanged");
    await restoreDatabase(path, backups, "offsite");
    assert.deepEqual(leadIds(path), [old.kept]);
    assert.throws(() => importBundle(old.bundle, backups), /BACKUP_EXISTS/);
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});
test("importing an older bundle never drops exclusions already in the local ledger", async () => {
  const host = await exportedHost("whiteoven-dr-same-");
  try {
    excludeFromRestore(host.backups, host.removed);
    host.store.deleteLead(host.removed);
    host.store.close();
    for (const suffix of ["", ".json"])
      rmSync(join(host.backups, `offsite.sqlite${suffix}`));
    assert.equal(importBundle(host.bundle, host.backups), "unchanged");
    assert.deepEqual(
      JSON.parse(readFileSync(join(host.backups, "deletions.json"), "utf8"))
        .ids,
      [host.removed],
    );
    await restoreDatabase(host.path, host.backups, "offsite");
    assert.deepEqual(leadIds(host.path), [host.kept]);
  } finally {
    rmSync(host.dir, { recursive: true, force: true });
  }
});
test("a different ledger with exclusions or bound backups is never overwritten", async () => {
  const old = await exportedHost("whiteoven-dr-conflict-");
  const other = mkdtempSync(join(tmpdir(), "whiteoven-dr-other-"));
  try {
    old.store.close();
    const backups = join(other, "backups");
    const ledgerFile = join(backups, "deletions.json");
    initializeLedger(backups);
    excludeFromRestore(backups, crypto.randomUUID());
    const before = readFileSync(ledgerFile, "utf8");
    assert.throws(() => importBundle(old.bundle, backups), /LEDGER_CONFLICT/);
    assert.throws(
      () => mergeLedger(backups, dumpLedger(old.backups)),
      /LEDGER_CONFLICT/,
    );
    assert.equal(readFileSync(ledgerFile, "utf8"), before);
    assert.deepEqual(readdirSync(backups), ["deletions.json"]);
    // Empty but already protecting a backup: also kept.
    rmSync(backups, { recursive: true });
    const store = new SqliteLeadStore(join(other, "leads.sqlite"));
    store.close();
    initializeLedger(backups);
    await backupDatabase(join(other, "leads.sqlite"), backups, "local");
    assert.throws(() => importBundle(old.bundle, backups), /LEDGER_CONFLICT/);
    verifyBackup(backups, "local");
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
test("tampered, inconsistent or expired bundles are rejected without touching the volume", async () => {
  const old = await exportedHost("whiteoven-dr-tamper-");
  const fresh = mkdtempSync(join(tmpdir(), "whiteoven-dr-reject-"));
  try {
    old.store.close();
    const backups = join(fresh, "backups");
    const bundle = JSON.parse(old.bundle);
    const variants = [
      { ...bundle, sqlite: Buffer.from("x").toString("base64") },
      { ...bundle, ledger: { ...bundle.ledger, id: crypto.randomUUID() } },
      {
        ...bundle,
        metadata: JSON.stringify({
          ...JSON.parse(bundle.metadata),
          expiresAt: "2000-01-01T00:00:00.000Z",
        }),
      },
      { ...bundle, format: "other" },
    ];
    for (const variant of variants) {
      assert.throws(() => importBundle(JSON.stringify(variant), backups));
      assert.deepEqual(readdirSync(backups), []);
    }
    assert.throws(() => importBundle(old.bundle, backups, "another-id"));
    assert.throws(() => importBundle(old.bundle.slice(0, 200), backups));
    assert.deepEqual(readdirSync(backups), []);
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
    rmSync(fresh, { recursive: true, force: true });
  }
});
test("exports taken while exclusions run concurrently are always internally consistent", async () => {
  const host = await exportedHost("whiteoven-dr-race-");
  try {
    host.store.close();
    const ids = Array.from({ length: 300 }, () => crypto.randomUUID());
    const storage = new URL("../scripts/storage.mjs", import.meta.url).href;
    const worker = new Worker(
      `const { workerData } = require("node:worker_threads");
       import(workerData.storage).then(({ excludeFromRestore }) => {
         for (const id of workerData.ids) excludeFromRestore(workerData.dir, id);
       });`,
      { eval: true, workerData: { storage, ids, dir: host.backups } },
    );
    const done = new Promise((resolve, reject) => {
      worker.on("exit", resolve);
      worker.on("error", reject);
    });
    const snapshots = [];
    let finished = false;
    done.then(() => (finished = true));
    while (!finished) {
      snapshots.push(exportBundle(host.backups, "offsite"));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await done;
    snapshots.push(exportBundle(host.backups, "offsite"));
    assert.ok(snapshots.length > 1);
    let previous = -1;
    for (const text of snapshots) {
      const bundle = JSON.parse(text);
      // Each snapshot is a prefix of the exclusion sequence: never torn, never reordered.
      assert.deepEqual(
        bundle.ledger.ids,
        ids.slice(0, bundle.ledger.ids.length),
      );
      assert.ok(bundle.ledger.ids.length >= previous);
      previous = bundle.ledger.ids.length;
      const target = mkdtempSync(join(tmpdir(), "whiteoven-dr-race-import-"));
      try {
        importBundle(text, join(target, "backups"));
        verifyBackup(join(target, "backups"), "offsite");
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    }
    assert.equal(previous, ids.length);
  } finally {
    rmSync(host.dir, { recursive: true, force: true });
  }
});
