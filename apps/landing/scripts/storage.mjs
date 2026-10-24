import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  chmodSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  copyFileSync,
  constants,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const digest = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const safeDir = (dir) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (statSync(dir).mode & 0o077) throw new Error("UNSAFE_DIRECTORY");
};
const safeId = (id) => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id ?? "")) throw new Error("INVALID_ID");
  return id;
};
const ledgerPath = (dir) => join(dir, "deletions.json");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Each ledger has its own identity. Backups record it, so a ledger recreated after loss
// can never be paired with older copies that may still hold deleted leads.
export function initializeLedger(dir) {
  safeDir(dir);
  if (!existsSync(ledgerPath(dir)))
    writeFileSync(
      ledgerPath(dir),
      JSON.stringify({
        version: 1,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ids: [],
      }),
      { flag: "wx", mode: 0o600 },
    );
}
function ledger(dir) {
  return parseLedger(readFileSync(ledgerPath(dir), "utf8"));
}
function parseLedger(text) {
  const value = typeof text === "string" ? JSON.parse(text) : { ...text };
  if (
    value.version !== 1 ||
    !UUID.test(value.id ?? "") ||
    !Array.isArray(value.ids) ||
    !value.ids.every((id) => UUID.test(id))
  )
    throw new Error("INVALID_LEDGER");
  value.ids = value.ids.map((id) => id.toLowerCase());
  return value;
}
export function excludeFromRestore(dir, id) {
  if (!UUID.test(id ?? "")) throw new Error("INVALID_ID");
  const value = ledger(dir);
  value.ids = [...new Set([...value.ids, id.toLowerCase()])];
  writeLedger(dir, value);
}
// Readers always see a whole ledger: writes go to a temporary file renamed over the old one.
function writeLedger(dir, value) {
  const temp = join(dir, `.ledger-${randomUUID()}`);
  writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  renameSync(temp, ledgerPath(dir));
}
const referencedLedgers = (dir) =>
  new Set(
    readdirSync(dir)
      .filter((name) => name.endsWith(".sqlite.json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, name), "utf8")).ledgerId;
        } catch {
          return undefined;
        }
      }),
  );
// Reconciles an external copy of the ledger without ever dropping a local exclusion.
// Same identity: union. No local ledger: adopt it. A different local ledger is only
// replaced when it provably carries nothing (no exclusions, no backup bound to it),
// and it is archived rather than deleted.
export function mergeLedger(dir, incoming) {
  safeDir(dir);
  const external = parseLedger(incoming);
  if (!existsSync(ledgerPath(dir))) {
    writeLedger(dir, external);
    return "adopted";
  }
  const local = ledger(dir);
  if (local.id === external.id) {
    const ids = [...new Set([...local.ids, ...external.ids])];
    if (ids.length === local.ids.length) return "unchanged";
    writeLedger(dir, { ...local, ids });
    return "merged";
  }
  if (local.ids.length > 0 || referencedLedgers(dir).has(local.id))
    throw new Error("LEDGER_CONFLICT");
  renameSync(
    ledgerPath(dir),
    join(dir, `deletions.superseded-${local.id}.json`),
  );
  writeLedger(dir, external);
  return "replaced-empty";
}
export const dumpLedger = (dir) => JSON.stringify(ledger(dir));
export function verifyBackup(dir, id) {
  safeId(id);
  const file = join(dir, `${id}.sqlite`);
  const meta = JSON.parse(readFileSync(`${file}.json`, "utf8"));
  if (meta.ledgerId !== ledger(dir).id) throw new Error("LEDGER_MISMATCH");
  if (
    meta.version !== 1 ||
    !Number.isFinite(Date.parse(meta.expiresAt)) ||
    meta.sha256 !== digest(file) ||
    Date.parse(meta.expiresAt) <= Date.now()
  )
    throw new Error("INVALID_BACKUP");
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma("quick_check", { simple: true }) !== "ok")
      throw new Error("INVALID_BACKUP");
    db.prepare("SELECT id FROM leads LIMIT 0").all();
  } finally {
    db.close();
  }
  return file;
}
export async function backupDatabase(source, dir, id) {
  safeDir(dir);
  safeId(id);
  // A copy without a ledger could not have deletions reapplied on restore.
  const ledgerId = ledger(dir).id;
  const file = join(dir, `${id}.sqlite`);
  if (existsSync(file)) {
    verifyBackup(dir, id);
    return file;
  }
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const earliest = db
      .prepare("SELECT MIN(expires_at) AS expiry FROM leads")
      .get().expiry;
    const expires = Math.min(Date.now() + 30 * 86400000, earliest ?? Infinity);
    if (expires <= Date.now()) throw new Error("PURGE_REQUIRED");
    await db.backup(file);
    // A self-contained file: no WAL sidecars left beside the copy or carried to external storage.
    const copy = new Database(file);
    try {
      copy.pragma("journal_mode = DELETE");
    } finally {
      copy.close();
    }
    chmodSync(file, 0o600);
    writeFileSync(
      `${file}.json`,
      JSON.stringify({
        version: 1,
        sha256: digest(file),
        ledgerId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(expires).toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    verifyBackup(dir, id);
    return file;
  } catch (error) {
    rmSync(file, { force: true });
    rmSync(`${file}.json`, { force: true });
    throw error;
  } finally {
    db.close();
  }
}
// Expired copies are already refused by restore; this removes them from the volume too.
export function pruneExpiredBackups(dir, now = Date.now()) {
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const match = /^([a-zA-Z0-9_-]{1,80})\.sqlite\.json$/.exec(name);
    if (!match) continue;
    const file = join(dir, `${match[1]}.sqlite`);
    let expiresAt = NaN;
    try {
      expiresAt = Date.parse(
        JSON.parse(readFileSync(join(dir, name), "utf8")).expiresAt,
      );
    } catch {
      /* Unreadable metadata cannot prove a copy is still within retention. */
    }
    if (Number.isFinite(expiresAt) && expiresAt > now) continue;
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(`${file}${suffix}`, { force: true });
    rmSync(join(dir, name), { force: true });
    removed++;
  }
  return removed;
}
// One self-contained, hash-checked bundle per export: backup, its metadata and a single
// read of the ledger. Separate copies could pair a ledger with the wrong backup or be
// left half-written; the bundle is either complete or rejected.
const BUNDLE = "whiteoven-backup-bundle";
export function exportBundle(dir, id) {
  const file = verifyBackup(dir, id);
  const sqlite = readFileSync(file);
  const metadata = readFileSync(`${file}.json`, "utf8");
  const snapshot = ledger(dir);
  if (JSON.parse(metadata).ledgerId !== snapshot.id)
    throw new Error("LEDGER_MISMATCH");
  return JSON.stringify({
    format: BUNDLE,
    version: 1,
    id,
    exportedAt: new Date().toISOString(),
    sqlite: sqlite.toString("base64"),
    metadata,
    ledger: snapshot,
  });
}
// Brings an exported bundle back into the backup volume: the backup files are never
// overwritten, and the ledger is reconciled with mergeLedger before the copy is usable.
export function importBundle(text, dir, expectedId) {
  safeDir(dir);
  const bundle = JSON.parse(text);
  if (bundle.format !== BUNDLE || bundle.version !== 1)
    throw new Error("INVALID_BUNDLE");
  const id = safeId(bundle.id);
  if (expectedId !== undefined && expectedId !== id)
    throw new Error("INVALID_BUNDLE");
  const sqlite = Buffer.from(bundle.sqlite, "base64");
  const metadata = JSON.parse(bundle.metadata);
  const external = parseLedger(bundle.ledger);
  if (
    metadata.sha256 !== createHash("sha256").update(sqlite).digest("hex") ||
    metadata.ledgerId !== external.id ||
    !(Date.parse(metadata.expiresAt) > Date.now())
  )
    throw new Error("INVALID_BUNDLE");
  const file = join(dir, `${id}.sqlite`);
  if (existsSync(file) || existsSync(`${file}.json`))
    throw new Error("BACKUP_EXISTS");
  // Decide on the ledger before writing anything, so a conflict leaves the volume untouched.
  if (existsSync(ledgerPath(dir))) {
    const local = ledger(dir);
    if (
      local.id !== external.id &&
      (local.ids.length > 0 || referencedLedgers(dir).has(local.id))
    )
      throw new Error("LEDGER_CONFLICT");
  }
  const staged = join(dir, `.import-${randomUUID()}.sqlite`);
  let placed = false;
  try {
    writeFileSync(staged, sqlite, { flag: "wx", mode: 0o600 });
    const db = new Database(staged, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma("quick_check", { simple: true }) !== "ok")
        throw new Error("INVALID_BUNDLE");
    } finally {
      db.close();
    }
    const result = mergeLedger(dir, external);
    writeFileSync(`${file}.json`, bundle.metadata, { flag: "wx", mode: 0o600 });
    placed = true;
    renameSync(staged, file);
    verifyBackup(dir, id);
    return result;
  } catch (error) {
    rmSync(staged, { force: true });
    if (placed) {
      rmSync(file, { force: true });
      rmSync(`${file}.json`, { force: true });
    }
    throw error;
  }
}
// Explicit write check on the data filesystem; never touches the leads database.
export function probeWrite(databasePath) {
  const probe = join(
    dirname(databasePath),
    `.write-probe-${randomUUID()}.sqlite`,
  );
  try {
    const db = new Database(probe);
    try {
      db.pragma("journal_mode = DELETE");
      db.pragma("synchronous = FULL");
      db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
      db.prepare("INSERT INTO probe (value) VALUES (?)").run("ok");
      if (db.prepare("SELECT value FROM probe").get().value !== "ok")
        throw new Error("WRITE_PROBE");
    } finally {
      db.close();
    }
  } finally {
    rmSync(probe, { force: true });
    rmSync(`${probe}-journal`, { force: true });
  }
}
export async function restoreDatabase(target, dir, id) {
  const source = verifyBackup(dir, id);
  const exclusions = ledger(dir);
  safeDir(dirname(target));
  // Never discard the current state, including records created after the selected backup.
  if (existsSync(target))
    await backupDatabase(
      target,
      dir,
      `before-restore-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
  const candidate = join(dirname(target), `.restore-${randomUUID()}.sqlite`);
  copyFileSync(source, candidate, constants.COPYFILE_EXCL);
  chmodSync(candidate, 0o600);
  try {
    const db = new Database(candidate);
    try {
      db.pragma("journal_mode = DELETE");
      db.pragma("foreign_keys = ON");
      db.pragma("secure_delete = ON");
      db.transaction(() => {
        for (const uuid of exclusions.ids)
          db.prepare("DELETE FROM leads WHERE id = ?").run(uuid);
        db.prepare("DELETE FROM leads WHERE expires_at <= ?").run(Date.now());
        db.prepare("DELETE FROM lead_requests WHERE expires_at <= ?").run(
          Date.now(),
        );
      })(); // only the isolated candidate is changed
      if (db.pragma("quick_check", { simple: true }) !== "ok")
        throw new Error("INVALID_BACKUP");
    } finally {
      db.close();
    }
    for (const suffix of ["-wal", "-shm"])
      rmSync(`${target}${suffix}`, { force: true });
    renameSync(candidate, target);
  } finally {
    rmSync(candidate, { force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const stdin = async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  };
  let stream;
  try {
    const [command, id, confirmation] = process.argv.slice(2);
    const source = process.env.LEADS_DB_PATH;
    const dir = process.env.STORAGE_BACKUP_DIR ?? "/var/backups/whiteoven";
    if (!source) throw new Error("MISSING_PATH");
    if (command === "backup") await backupDatabase(source, dir, id);
    else if (command === "verify") verifyBackup(dir, id);
    else if (command === "ledger-init") initializeLedger(dir);
    else if (command === "exclude") excludeFromRestore(dir, id);
    else if (command === "prune") pruneExpiredBackups(dir);
    else if (command === "import") importBundle(await stdin(), dir, id);
    else if (command === "ledger-merge") mergeLedger(dir, await stdin());
    else if (command === "export") stream = exportBundle(dir, id);
    else if (command === "ledger-dump") stream = dumpLedger(dir);
    else if (command === "probe-write") probeWrite(source);
    else if (command === "restore" && confirmation === "--confirm-offline")
      await restoreDatabase(source, dir, id);
    else throw new Error("INVALID_OPERATION");
    // Exports own stdout; the confirmation goes to stderr so it never mixes with data.
    if (stream !== undefined) process.stdout.write(stream);
    (stream === undefined ? console.log : console.error)(
      "Operação de armazenamento concluída. Registre a evidência no inventário restrito.",
    );
  } catch {
    console.error(
      "Operação de armazenamento não concluída. Confira configuração, permissões, inventário, integridade e prazo da cópia.",
    );
    process.exitCode = 1;
  }
}
