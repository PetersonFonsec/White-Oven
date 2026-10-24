import Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { recordWrite } from "./persistence-health.ts";
import {
  type LeadSubmission,
  type Lead,
  type ConsentPolicySnapshot,
} from "@whiteoven/contracts";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEDUPLICATION_MS = 15 * 60 * 1000;
export class IdempotencyConflict extends Error {
  constructor() {
    super("IDEMPOTENCY_CONFLICT");
  }
}
export interface SaveResult {
  lead: Lead;
  created: boolean;
}
export interface LeadRepository {
  save(
    input: LeadSubmission,
    key: string,
    policy: ConsentPolicySnapshot,
    now: number,
  ): SaveResult;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class SqliteLeadStore implements LeadRepository {
  private db: Database.Database;
  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      if ((statSync(dirname(filename)).mode & 0o077) !== 0)
        throw new Error("UNSAFE_STORAGE_DIRECTORY");
    }
    this.db = new Database(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("secure_delete = ON");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        fingerprint TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS leads_fingerprint_date ON leads (fingerprint, created_at);
      CREATE INDEX IF NOT EXISTS leads_expiry ON leads (expires_at);
      CREATE TABLE IF NOT EXISTS lead_requests (
        key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
    `);
  }
  save(
    input: LeadSubmission,
    key: string,
    policy: ConsentPolicySnapshot,
    now: number,
  ): SaveResult {
    try {
      const result = this.write(input, key, policy, now);
      recordWrite(true, now);
      return result;
    } catch (error) {
      // A conflict is a client error, not evidence about storage.
      if (!(error instanceof IdempotencyConflict)) recordWrite(false, now);
      throw error;
    }
  }
  private write(
    input: LeadSubmission,
    key: string,
    policy: ConsentPolicySnapshot,
    now: number,
  ): SaveResult {
    return this.db
      .transaction(() => {
        this.purgeExpired(now);
        // Fixed property order makes this snapshot identity independent of object insertion order.
        const policyId = digest([
          policy.version,
          policy.text,
          policy.controllerName,
          policy.privacyEmail,
          policy.retentionDays,
        ]);
        const payloadHash = digest([input, policyId]);
        const existing = this.db
          .prepare(
            "SELECT payload_hash, lead_id FROM lead_requests WHERE key = ?",
          )
          .get(key) as { payload_hash: string; lead_id: string } | undefined;
        if (existing) {
          if (existing.payload_hash !== payloadHash)
            throw new IdempotencyConflict();
          const row = this.db
            .prepare("SELECT data FROM leads WHERE id = ?")
            .get(existing.lead_id) as { data: string };
          return { lead: JSON.parse(row.data) as Lead, created: false };
        }
        // Attribution is first-touch; repeated identical business interest keeps the first record.
        const fingerprint = digest([
          input.responsibleName.toLocaleLowerCase("pt-BR"),
          input.pizzeriaName.toLocaleLowerCase("pt-BR"),
          input.whatsapp,
          input.monthlyOrderVolume,
          input.interestedPlan,
          input.consentVersion,
          policyId,
        ]);
        const duplicate = this.db
          .prepare(
            "SELECT data FROM leads WHERE fingerprint = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1",
          )
          .get(fingerprint, now - DEDUPLICATION_MS) as
          { data: string } | undefined;
        let lead: Lead;
        if (duplicate) lead = JSON.parse(duplicate.data) as Lead;
        else {
          const { website: _website, ...values } = input;
          void _website;
          lead = {
            ...values,
            id: randomUUID(),
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(
              now + policy.retentionDays * 86400000,
            ).toISOString(),
            consentPolicy: policy,
          };
          this.db
            .prepare(
              "INSERT INTO leads (id, created_at, expires_at, fingerprint, data) VALUES (?, ?, ?, ?, ?)",
            )
            .run(
              lead.id,
              now,
              Date.parse(lead.expiresAt),
              fingerprint,
              JSON.stringify(lead),
            );
        }
        this.db
          .prepare(
            "INSERT INTO lead_requests (key, payload_hash, lead_id, expires_at) VALUES (?, ?, ?, ?)",
          )
          .run(key, payloadHash, lead.id, now + IDEMPOTENCY_TTL_MS);
        return { lead, created: !duplicate };
      })
      .immediate();
  }
  purgeExpired(now = Date.now()): number {
    this.db.prepare("DELETE FROM lead_requests WHERE expires_at <= ?").run(now);
    return this.db.prepare("DELETE FROM leads WHERE expires_at <= ?").run(now)
      .changes;
  }
  exportLeads(now = Date.now()): Lead[] {
    this.purgeExpired(now);
    return (
      this.db.prepare("SELECT data FROM leads ORDER BY created_at").all() as {
        data: string;
      }[]
    ).map((row) => JSON.parse(row.data) as Lead);
  }
  deleteLead(id: string): boolean {
    return (
      this.db.prepare("DELETE FROM leads WHERE id = ?").run(id).changes > 0
    );
  }
  clearDevelopment(): void {
    this.db.exec("DELETE FROM lead_requests; DELETE FROM leads;");
  }
  isHealthy(): boolean {
    this.db.prepare("SELECT id FROM leads LIMIT 0").all();
    this.db.prepare("SELECT key FROM lead_requests LIMIT 0").all();
    return this.db.pragma("quick_check", { simple: true }) === "ok";
  }
  close(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}
