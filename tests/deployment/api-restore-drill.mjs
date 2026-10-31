// M7.1 restore drill (ADR 0029, docs/operations/api-backup-restore.md): runs ops/api-backup.sh
// against an isolated copy of the development Compose with synthetic data only, and prints the
// record the runbook asks for. Two scenarios:
//   1. Same host: backup, a customer deletes the account, restore. The deletion must survive.
//   2. Host lost: volumes destroyed, fresh cluster, restore with the exported deletion ledger.
//      Without the ledger the restore must refuse.
//
//   node tests/deployment/api-restore-drill.mjs
//
// WHITEOVEN_DRILL_SKIP_BUILD=1 uses an existing whiteoven-api:dev image. WHITEOVEN_DRILL_RECORD
// names a file that receives the record as JSON.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "whiteoven-drill-"));
const project = `whiteoven-drill-${randomBytes(3).toString("hex")}`;
const dbPort = process.env.WHITEOVEN_DRILL_DB_PORT ?? "55432";
const apiPort = process.env.WHITEOVEN_DRILL_API_PORT ?? "53000";
const api = `http://127.0.0.1:${apiPort}/v1`;
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  WHITEOVEN_DB_PORT: dbPort,
  WHITEOVEN_API_PORT: apiPort,
  WHITEOVEN_API_COMPOSE_FILE: "compose.dev.yaml",
  WHITEOVEN_API_BACKUP_DIR: join(work, "backups"),
  WHITEOVEN_STATE_DIR: join(work, "state"),
};
const PASSWORD = "ensaio-senha-forte-2026";
const slug = `ensaio-${randomBytes(3).toString("hex")}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: options.binary ? "buffer" : "utf8",
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr}`,
    );
  return result;
}
const compose = (...args) =>
  run("docker", ["compose", "-f", "compose.dev.yaml", ...args]);
const ops = (args, options) =>
  run("bash", ["ops/api-backup.sh", ...args], options);
/** Superuser query on the drill database; returns trimmed text output. */
const sql = (query, database = "whiteoven", user = "postgres") =>
  compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    user,
    "-d",
    database,
    "-At",
    "-c",
    query,
  ).stdout.trim();
const inApi = (script, input) =>
  run(
    "docker",
    [
      "compose",
      "-f",
      "compose.dev.yaml",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "--entrypoint",
      "sh",
      "api",
      "-c",
      script,
    ],
    { input, binary: true },
  );
const up = () => compose("up", "-d", "--wait", "--wait-timeout", "120", "api");
const seconds = (start) => Math.round((Date.now() - start) / 100) / 10;

async function customerCall(path, method = "GET", body, token, retry = true) {
  const request = () =>
    fetch(`${api}/customer/stores/${slug}/${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  // A kept-alive socket to the API container that the restore stopped fails once.
  const response = await request().catch((error) => {
    if (!retry) throw error;
    return request();
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function register(label) {
  const email = `${label}-${randomUUID()}@ensaio.invalid`;
  const created = await customerCall("auth/register", "POST", {
    name: `Cliente ${label}`,
    email,
    password: PASSWORD,
    privacyPolicyVersion: "ensaio",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const token = created.body.accessToken;
  const me = await customerCall("me", "GET", undefined, token);
  const address = await customerCall(
    "me/addresses",
    "POST",
    {
      label: "Casa",
      postalCode: "01310100",
      street: "Rua Sintética",
      number: "1",
      district: "Centro",
      city: "São Paulo",
      state: "SP",
    },
    token,
  );
  assert.equal(address.status, 201, JSON.stringify(address.body));
  return { id: me.body.id, email, token };
}
const loginStatus = async (customer) =>
  (
    await customerCall("auth/login", "POST", {
      email: customer.email,
      password: PASSWORD,
    })
  ).status;

/** An image the way LocalImageStorage keeps it: metadata row plus two variant files. */
function addImage(tenantId) {
  const id = randomUUID();
  sql(
    `begin; select set_config('app.tenant_id', '${tenantId}', true);
     insert into image_assets (id, tenant_id, source_format, width, height)
     values ('${id}', '${tenantId}', 'png', 10, 10); commit;`,
    "whiteoven",
    "whiteoven_owner",
  );
  const bytes = randomBytes(2048);
  for (const variant of ["menu", "thumbnail"])
    inApi(
      `set -eu; d=/var/lib/whiteoven/images/tenants/${tenantId}/${id}; mkdir -p "$d"; cat > "$d/${variant}.webp"`,
      bytes,
    );
  return { id, sha: createHash("sha256").update(bytes).digest("hex") };
}
function imageSha(tenantId, id, prefix = "") {
  const result = inApi(
    `f=/var/lib/whiteoven/images/${prefix}tenants/${tenantId}/${id}/menu.webp; [ -f "$f" ] && cat "$f" || true`,
  );
  return result.stdout.length
    ? createHash("sha256").update(result.stdout).digest("hex")
    : null;
}
const customerStatus = (id) =>
  sql(
    `select status || ':' || (email is null)::text from customers where id = '${id}'`,
  );

const record = {
  milestone: "M7.1",
  date: new Date().toISOString(),
  commit: run("git", ["rev-parse", "HEAD"]).stdout.trim(),
  data: "sintéticos",
  scenarios: [],
};

try {
  if (process.env.WHITEOVEN_DRILL_SKIP_BUILD !== "1") compose("build", "api");
  up();
  record.postgres = sql("show server_version");
  const tenantId = sql(
    `insert into tenants (slug, display_name, status) values ('${slug}', 'Pizzaria Ensaio', 'ACTIVE') returning id`,
  ).split("\n")[0];
  sql(
    `begin; select set_config('app.tenant_id', '${tenantId}', true);
     insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from)
     select '${tenantId}', code, fee_basis_points, monthly_fee_cents, now() - interval '1 day'
       from plans where code = 'FLEX'; commit;`,
  );

  // State at backup time: A and B active with addresses, one image.
  const a = await register("a");
  const b = await register("b");
  const before = addImage(tenantId);
  let start = Date.now();
  ops(["backup", "ensaio-1"]);
  record.backupSeconds = seconds(start);
  ops(["verify-backup", "ensaio-1"]);
  const manifest = readFileSync(
    join(env.WHITEOVEN_API_BACKUP_DIR, "ensaio-1", "manifest.txt"),
    "utf8",
  );
  record.backupManifest = Object.fromEntries(
    manifest
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );

  // A corrupted copy is refused before anything changes.
  cpSync(
    join(env.WHITEOVEN_API_BACKUP_DIR, "ensaio-1"),
    join(env.WHITEOVEN_API_BACKUP_DIR, "adulterada"),
    { recursive: true },
  );
  const tampered = join(
    env.WHITEOVEN_API_BACKUP_DIR,
    "adulterada",
    "images.tar",
  );
  const tar = readFileSync(tampered);
  tar[tar.length - 1] ^= 0xff;
  writeFileSync(tampered, tar);
  const refusedTamper = ops(["verify-backup", "adulterada"], {
    allowFailure: true,
  });
  assert.notEqual(refusedTamper.status, 0);
  assert.match(refusedTamper.stderr, /Hash das imagens não confere/);
  rmSync(join(env.WHITEOVEN_API_BACKUP_DIR, "adulterada"), { recursive: true });

  // After the backup: A deletes the account, C signs up, a second image arrives.
  const deleted = await customerCall(
    "me",
    "DELETE",
    { password: PASSWORD },
    a.token,
  );
  assert.equal(deleted.status, 204);
  const c = await register("c");
  const after = addImage(tenantId);
  ops(["export-erasures", join(work, "ledger")]);
  const ledger = join(work, "ledger", readdirSync(join(work, "ledger"))[0]);
  assert.equal(readFileSync(ledger, "utf8").trim().split("\n").length, 2);

  // Scenario 1: restore on the same host.
  start = Date.now();
  const restored = ops(["restore", "ensaio-1", "--confirm-offline"]);
  const restoreSeconds = seconds(start);
  start = Date.now();
  up();
  const restartSeconds = seconds(start);
  assert.equal(
    customerStatus(a.id),
    "DELETED:true",
    "A's deletion survived the restore",
  );
  assert.equal(await loginStatus(a), 401);
  assert.equal(await loginStatus(b), 200, "B came back from the backup");
  assert.equal(
    sql(
      `select count(*) from customer_addresses where customer_id = '${a.id}'`,
    ),
    "0",
  );
  assert.equal(
    sql(
      `select count(*) from customer_addresses where customer_id = '${b.id}'`,
    ),
    "1",
  );
  assert.equal(await loginStatus(c), 401, "C signed up after the backup");
  assert.equal(
    imageSha(tenantId, before.id),
    before.sha,
    "image from the backup restored byte for byte",
  );
  assert.equal(
    imageSha(tenantId, after.id),
    null,
    "image newer than the backup is not live",
  );
  const previousImages = readFileSync(
    join(env.WHITEOVEN_STATE_DIR, "api-restore.log"),
    "utf8",
  ).match(/previous_images=(\S+)/)[1];
  assert.equal(
    imageSha(tenantId, after.id, `${previousImages}/`),
    after.sha,
    "newer image kept aside",
  );
  const previousDb = restored.stdout.match(/previous_db=(\S+)/)[1];
  assert.equal(
    sql(`select count(*) from customers where id = '${c.id}'`, previousDb),
    "1",
    "newer data kept in the previous database",
  );
  assert.ok(
    existsSync(
      join(
        env.WHITEOVEN_API_BACKUP_DIR,
        `pre-restore-${previousDb.split("_").pop()}`,
      ),
    ),
  );
  record.scenarios.push({
    name: "mesmo host",
    restoreSeconds,
    restartSeconds,
    log: restored.stdout.match(/restore id=.*/)[0],
    checks: [
      "exclusão feita depois da cópia reaplicada (status DELETED, sem e-mail, login 401, sem endereço)",
      "cliente da cópia volta e entra; cliente criado depois da cópia não está no banco ativo",
      "imagem da cópia idêntica byte a byte; imagem posterior guardada à parte",
      "banco anterior e cópia de segurança pre-restore preservados",
    ],
  });

  // Scenario 2: the host is lost. Only the backup directory and the exported ledger survive.
  compose("down", "-v");
  up();
  const refused = ops(["restore", "ensaio-1", "--confirm-offline"], {
    allowFailure: true,
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /ERASURES_MISSING/);
  start = Date.now();
  const recovered = ops([
    "restore",
    "ensaio-1",
    "--confirm-offline",
    "--erasures",
    ledger,
  ]);
  const recoverSeconds = seconds(start);
  up();
  assert.equal(
    customerStatus(a.id),
    "DELETED:true",
    "the ledger carried A's deletion to the new host",
  );
  assert.equal(await loginStatus(a), 401);
  assert.equal(await loginStatus(b), 200);
  assert.equal(imageSha(tenantId, before.id), before.sha);
  assert.equal(
    sql(
      "select count(*) from pg_stat_activity where usename = 'whiteoven_app'",
    ) !== "0",
    true,
    "the API connects as whiteoven_app",
  );
  record.scenarios.push({
    name: "perda do host",
    restoreSeconds: recoverSeconds,
    log: recovered.stdout.match(/restore id=.*/)[0],
    checks: [
      "restore sem diário recusado com ERASURES_MISSING",
      "restore com o diário exportado reaplica a exclusão em cluster novo",
      "API volta saudável como whiteoven_app sobre o banco restaurado",
    ],
  });
  record.result = "aprovado";
  console.log(JSON.stringify(record, null, 2));
  if (process.env.WHITEOVEN_DRILL_RECORD)
    writeFileSync(
      process.env.WHITEOVEN_DRILL_RECORD,
      `${JSON.stringify(record, null, 2)}\n`,
    );
} finally {
  run("docker", ["compose", "-f", "compose.dev.yaml", "down", "-v"], {
    allowFailure: true,
  });
  rmSync(work, { recursive: true, force: true });
}
