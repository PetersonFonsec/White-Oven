// M7.1 restore drill (ADR 0029, docs/operations/api-backup-restore.md): runs ops/api-backup.sh
// against an isolated copy of the development Compose with synthetic data only, and prints the
// record the runbook asks for. Nothing here touches a real environment.
//
//   1. Backup taken while image uploads run; every referenced image must be in it, complete.
//   2. Failures injected before the swap (candidate, pg_restore, image extraction, reapply): the
//      live set stays intact, the failed operation blocks the next one until restore-rollback.
//   3. A candidate name that already exists is never touched.
//   4. Failures injected during the swap: automatic rollback to the original set.
//   5. The process killed during the swap (and PostgreSQL restarted): the API cannot connect,
//      the operation is reported pending, restore-rollback recovers it.
//   6. Two full restores: distinct candidates, deletion kept, restore-cleanup.
//   7. Database recreated in the same cluster: refused without ledger and with a ledger of another
//      lineage, tampered, incomplete, older than the backup or older than what this host saw;
//      accepted with the current ledger.
//   8. Host lost: refused without ledger, accepted with it.
//   9. A committed image truncated on the volume makes the backup fail.
//
//   node tests/deployment/api-restore-drill.mjs
//
// WHITEOVEN_DRILL_SKIP_BUILD=1 uses an existing whiteoven-api:dev image. WHITEOVEN_DRILL_RECORD
// names a file that receives the record as JSON.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
import { crc32, deflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "whiteoven-drill-"));
const project = `whiteoven-drill-${randomBytes(3).toString("hex")}`;
const dbPort = process.env.WHITEOVEN_DRILL_DB_PORT ?? "55432";
const apiPort = process.env.WHITEOVEN_DRILL_API_PORT ?? "53000";
const api = `http://127.0.0.1:${apiPort}/v1`;
const backups = join(work, "backups");
const state = join(work, "state");
const env = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  WHITEOVEN_DB_PORT: dbPort,
  WHITEOVEN_API_PORT: apiPort,
  WHITEOVEN_API_COMPOSE_FILE: "compose.dev.yaml",
  WHITEOVEN_API_BACKUP_DIR: backups,
  WHITEOVEN_STATE_DIR: state,
};
for (const name of [
  "WHITEOVEN_TEST_FAIL_AT",
  "WHITEOVEN_TEST_KILL_AT",
  "WHITEOVEN_TEST_OPERATION_ID",
])
  delete env[name];
const PASSWORD = "ensaio-senha-forte-2026";
const slug = `ensaio-${randomBytes(3).toString("hex")}`;
const IMAGES = "/var/lib/whiteoven/images";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...env, ...options.env },
    encoding: options.binary ? "buffer" : "utf8",
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!options.allowFailure && result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal}):\n${result.stderr}`,
    );
  return result;
}
function runAsync(command, args) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}
const compose = (...args) =>
  run("docker", ["compose", "-f", "compose.dev.yaml", ...args]);
const ops = (args, options) =>
  run("bash", ["ops/api-backup.sh", ...args], options);
/** A restore expected to fail with `pattern`; returns the result. */
function refused(args, pattern, extraEnv = {}) {
  const result = ops(args, { allowFailure: true, env: extraEnv });
  assert.notEqual(result.status, 0, `${args.join(" ")} should fail`);
  assert.match(result.stderr, pattern);
  return result;
}
/** Superuser query; returns trimmed text output. */
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
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// --- HTTP, with one retry for a kept-alive socket to an API container the restore stopped.
async function call(url, init = {}) {
  return fetch(url, init).catch(() => fetch(url, init));
}
async function customerCall(path, method = "GET", body, token) {
  const response = await call(`${api}/customer/stores/${slug}/${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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
async function deleteAccount(customer) {
  const deleted = await customerCall(
    "me",
    "DELETE",
    { password: PASSWORD },
    customer.token,
  );
  assert.equal(deleted.status, 204);
}
const loginStatus = async (customer) =>
  (
    await customerCall("auth/login", "POST", {
      email: customer.email,
      password: PASSWORD,
    })
  ).status;
const customerStatus = (id) =>
  sql(
    `select status || ':' || (email is null)::text from customers where id = '${id}'`,
  );

// --- Staff and real uploads through the API (LocalImageStorage, ADR 0010).
const staffEmail = `dono-${randomBytes(3).toString("hex")}@ensaio.invalid`;
async function staffToken(tenantId) {
  const login = await call(`${api}/admin/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: staffEmail, password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const { accessToken } = await login.json();
  const switched = await call(`${api}/admin/auth/active-tenant`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ tenantId }),
  });
  assert.equal(switched.status, 200);
  return (await switched.json()).accessToken;
}
/** A random-pixel PNG, so every upload has distinct bytes. */
function png(size = 64) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let row = 0; row < size; row += 1)
    randomBytes(size * 3).copy(raw, row * (size * 3 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function upload(token) {
  const response = await call(`${api}/admin/catalog/images`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "image/png" },
    body: png(),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const { id } = await response.json();
  const menu = await call(`${api}/admin/catalog/images/${id}/menu`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(menu.status, 200);
  return { id, sha: sha(Buffer.from(await menu.arrayBuffer())) };
}

// --- The image volume, read through a one-off API container as a tar stream.
function untar(buffer) {
  const files = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const prefix = text(345, 500);
    const name = prefix ? `${prefix}/${text(0, 100)}` : text(0, 100);
    const size = parseInt(text(124, 136).trim() || "0", 8);
    const type = text(156, 157);
    if (type === "0" || type === "")
      files.set(name, buffer.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
/** Files under `<prefix>tenants`, keyed `tenants/<tenant>/<asset>/<variant>.webp`. */
const volumeFiles = (prefix = "") =>
  untar(
    inApi(
      `cd ${IMAGES}/${prefix} 2>/dev/null && [ -d tenants ] && exec tar -cf - tenants || true`,
    ).stdout,
  );
const volumeEntries = () =>
  inApi(`ls -A ${IMAGES}`).stdout.toString().trim().split("\n").filter(Boolean);
const webpComplete = (bytes) =>
  bytes !== undefined &&
  bytes.length >= 12 &&
  bytes.toString("latin1", 0, 4) === "RIFF" &&
  bytes.toString("latin1", 8, 12) === "WEBP" &&
  bytes.readUInt32LE(4) + 8 === bytes.length;
const menuPath = (tenantId, id) => `tenants/${tenantId}/${id}/menu.webp`;
/** Every image the live database references exists, complete; returns how many. */
function assertReferencedImagesComplete(files = volumeFiles()) {
  const rows = sql("select tenant_id || ' ' || id from image_assets")
    .split("\n")
    .filter(Boolean);
  for (const row of rows) {
    const [tenant, asset] = row.split(" ");
    for (const variant of ["thumbnail", "menu"])
      assert.ok(
        webpComplete(files.get(`tenants/${tenant}/${asset}/${variant}.webp`)),
        `referenced image ${tenant}/${asset}/${variant} missing or truncated`,
      );
  }
  return rows.length;
}

// --- Restore operations.
const opState = (op) =>
  Object.fromEntries(
    readFileSync(join(state, "api-restores", op, "state"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
const restoreDatabases = () =>
  sql(
    "select coalesce(string_agg(datname, ' ' order by datname), '') from pg_database where datname ~ '^whiteoven_(rc|prev)_'",
    "postgres",
  );
const dbComment = (name) =>
  sql(
    `select coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '${name}'`,
    "postgres",
  );
const appCanConnect = () =>
  sql(
    "select coalesce((select has_database_privilege('whiteoven_app', oid, 'CONNECT') from pg_database where datname = 'whiteoven'), false)",
    "postgres",
  );
const lockHeld = () => existsSync(join(state, "api-backup.lock"));
const backupHead = (dir) =>
  readFileSync(join(backups, dir, "manifest.txt"), "utf8");

const record = {
  milestone: "M7.1",
  date: new Date().toISOString(),
  commit: run("git", ["rev-parse", "HEAD"]).stdout.trim(),
  data: "sintéticos",
  scenarios: [],
};
let opCounter = 0;
const nextOp = () =>
  `20261031${String(++opCounter).padStart(6, "0")}_${randomBytes(3).toString("hex")}`;

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
  const hash = inApi(
    `node -e 'require("./dist/auth/password.js").hashPassword(process.argv[1]).then((h) => process.stdout.write(h))' '${PASSWORD}'`,
  ).stdout.toString();
  const staffId = sql(
    `insert into staff_users (email, name, password_hash, status)
     values ('${staffEmail}', 'Dono Ensaio', $h$${hash}$h$, 'ACTIVE') returning id`,
  ).split("\n")[0];
  sql(
    `insert into memberships (tenant_id, staff_user_id, role, status) values ('${tenantId}', '${staffId}', 'OWNER', 'ACTIVE')`,
  );
  let token = await staffToken(tenantId);

  // Z deletes the account before anything else; ledgerBefore is older than the backup.
  const z = await register("z");
  ops(["export-erasures", join(work, "ledger-before")]);
  await deleteAccount(z);
  const a = await register("a");
  const b = await register("b");
  const image1 = await upload(token);
  // A variant still being written (temporary name) must never enter a backup.
  inApi(
    `set -eu; f=${IMAGES}/tenants/${tenantId}/${image1.id}/menu.webp.${randomUUID()}.tmp; printf RIFF > "$f"`,
  );

  // 1. Backup while uploads run.
  let start = Date.now();
  const backupRun = runAsync("bash", [
    "ops/api-backup.sh",
    "backup",
    "ensaio-1",
  ]);
  let backupDone = false;
  void backupRun.then(() => (backupDone = true));
  const concurrent = [];
  while (!backupDone)
    concurrent.push(
      ...(await Promise.all([upload(token), upload(token), upload(token)])),
    );
  const backupResult = await backupRun;
  assert.equal(backupResult.status, 0, backupResult.stderr);
  record.backupSeconds = seconds(start);
  ops(["verify-backup", "ensaio-1"]);
  const manifest = backupHead("ensaio-1");
  record.backupManifest = Object.fromEntries(
    manifest
      .trim()
      .split("\n")
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  const archived = untar(readFileSync(join(backups, "ensaio-1", "images.tar")));
  assert.ok(
    ![...archived.keys()].some((name) => name.endsWith(".tmp")),
    "temporary variants are not backed up",
  );
  assert.ok(Number(record.backupManifest.referenced_images) >= 1);
  record.scenarios.push({
    name: "backup durante uploads concorrentes",
    uploadsDuringBackup: concurrent.length,
    referencedImagesInBackup: Number(record.backupManifest.referenced_images),
    checks: [
      "verify-backup confere hashes e que toda imagem referenciada pelo dump está no arquivo, completa (RIFF/WEBP)",
      "variantes temporárias (*.tmp) não entram na cópia",
    ],
  });

  // A corrupted copy is refused before anything changes.
  cpSync(join(backups, "ensaio-1"), join(backups, "adulterada"), {
    recursive: true,
  });
  const tampered = join(backups, "adulterada", "images.tar");
  const tar = readFileSync(tampered);
  tar[tar.length - 1] ^= 0xff;
  writeFileSync(tampered, tar);
  refused(["verify-backup", "adulterada"], /Hash das imagens não confere/);
  rmSync(join(backups, "adulterada"), { recursive: true });

  // After the backup: A deletes the account, C signs up, another image arrives.
  ops(["export-erasures", join(work, "ledger-at-backup")]);
  await deleteAccount(a);
  ops(["export-erasures", join(work, "ledger-after")]);
  const c = await register("c");
  const image2 = await upload(token);
  const ledgerOf = (dir) =>
    join(
      work,
      dir,
      readdirSync(join(work, dir)).find((f) => f.endsWith(".csv")),
    );
  const ledgerBefore = ledgerOf("ledger-before");
  const ledgerAtBackup = ledgerOf("ledger-at-backup");
  const ledgerAfter = ledgerOf("ledger-after");
  const exportedAt = (file) =>
    readFileSync(file, "utf8").match(/exported_at=(\S+)/)[1];
  const ackAfter = ["--accept-erasures-until", exportedAt(ledgerAfter)];
  assert.match(
    readFileSync(ledgerAfter, "utf8"),
    /^# whiteoven-customer-erasures-2 .* head=2 /,
  );

  /** The live set is the one before any restore attempt. */
  function assertLiveIntact() {
    assert.equal(
      sql(`select count(*) from customers where id = '${c.id}'`),
      "1",
    );
    assert.equal(customerStatus(a.id), "DELETED:true");
    assert.equal(dbComment("whiteoven"), "");
    assert.equal(appCanConnect(), "t", "the API role can connect again");
    const files = volumeFiles();
    assert.equal(sha(files.get(menuPath(tenantId, image2.id))), image2.sha);
    assertReferencedImagesComplete(files);
  }
  function assertClosed(op, phase, entries = ["tenants"]) {
    assert.equal(opState(op).phase, phase);
    assert.equal(
      restoreDatabases(),
      "",
      "no candidate or previous database left",
    );
    assert.deepEqual(
      volumeEntries(),
      entries,
      "no staging or aside directory left",
    );
    assert.equal(lockHeld(), false);
  }

  // 2. Failures before the swap: nothing in use changes; the operation stays pending.
  const preSwap = [
    ["candidate_prepare", "CANDIDATE_CREATED"],
    ["pg_restore", "CANDIDATE_CREATED"],
    ["images_extract", "CANDIDATE_RESTORED"],
    ["reapply", "API_STOPPED"],
  ];
  for (const [point, phase] of preSwap) {
    const op = nextOp();
    const result = refused(
      ["restore", "ensaio-1", "--confirm-offline"],
      /antes de qualquer troca/,
      { WHITEOVEN_TEST_FAIL_AT: point, WHITEOVEN_TEST_OPERATION_ID: op },
    );
    const s = opState(op);
    assert.equal(s.phase, "FAILED");
    assert.equal(s.failed_phase, phase, `${point}: ${result.stderr}`);
    assert.equal(lockHeld(), false, "lock released after a failure");
    assert.equal(
      dbComment(s.candidate),
      `whiteoven-restore candidate op=${op}`,
      "candidate kept for investigation",
    );
    if (point === "images_extract")
      assert.ok(volumeEntries().includes(s.staging), "staging kept");
    if (point === "reapply") {
      const log = join(state, "api-restores", op, "reapply.log");
      assert.ok(existsSync(log), result.stderr);
      assert.match(readFileSync(log, "utf8"), /division by zero/);
    }
    assertLiveIntact();
    assert.match(
      ops(["restore-status"]).stdout,
      new RegExp(`${op} fase=FAILED .*\\[PENDENTE\\]`),
    );
    refused(
      ["restore", "ensaio-1", "--confirm-offline"],
      /Há restauração incompleta/,
    );
    ops(["restore-rollback", op]);
    assertClosed(op, "ROLLED_BACK");
  }
  record.scenarios.push({
    name: "falhas antes da troca",
    points: preSwap.map(([point]) => point),
    checks: [
      "banco e imagens em uso intactos; CONNECT da API preservado",
      "candidato marcado e preparo das imagens mantidos para investigação; reapply.log com o erro",
      "lock liberado; operação FAILED bloqueia outro restore até restore-rollback",
      "restore-rollback remove só os recursos marcados da operação",
    ],
  });

  // 3. A candidate name that already exists is never dropped or overwritten.
  {
    const op = nextOp();
    const squatter = `whiteoven_rc_${op}`;
    sql(`create database "${squatter}"`, "postgres");
    sql(
      "create table sentinel (id int); insert into sentinel values (42)",
      squatter,
    );
    refused(
      ["restore", "ensaio-1", "--confirm-offline"],
      /já existe e não pertence/,
      {
        WHITEOVEN_TEST_OPERATION_ID: op,
      },
    );
    assert.equal(sql("select id from sentinel", squatter), "42");
    const rollback = ops(["restore-rollback", op]);
    assert.match(
      rollback.stderr,
      /sem a marca desta operação e não foi removido/,
    );
    assert.equal(sql("select id from sentinel", squatter), "42");
    sql(`drop database "${squatter}"`, "postgres");
    assertClosed(op, "ROLLED_BACK");
    assertLiveIntact();
  }
  record.scenarios.push({
    name: "colisão de candidato",
    checks: [
      "banco preexistente com o nome do candidato recusado e preservado (tabela sentinela intacta), inclusive no rollback",
    ],
  });

  // 4. Failures during the swap: rolled back automatically.
  const inSwap = [
    ["swap_prepare", "SWAP_STARTED"],
    ["after_db_swap", "DB_SWAPPED"],
    ["images_swap", "IMAGES_SWAPPING"],
  ];
  for (const [point, phase] of inSwap) {
    const op = nextOp();
    refused(
      ["restore", "ensaio-1", "--confirm-offline"],
      /Rollback concluído/,
      {
        WHITEOVEN_TEST_FAIL_AT: point,
        WHITEOVEN_TEST_OPERATION_ID: op,
      },
    );
    assert.equal(opState(op).failed_phase, phase);
    assertClosed(op, "ROLLED_BACK");
    assertLiveIntact();
  }
  up();
  assert.equal(await loginStatus(c), 200, "API healthy on the original set");
  token = await staffToken(tenantId);
  record.scenarios.push({
    name: "falhas durante a troca",
    points: inSwap.map(([point]) => point),
    checks: [
      "rollback automático devolve banco, imagens e CONNECT originais",
      "API volta saudável sobre o conjunto original",
    ],
  });

  // 5. The process dies during the swap.
  const kills = [
    ["db_rename", "DB_SWAPPING"],
    ["after_db_swap", "DB_SWAPPED"],
    ["before_complete", "IMAGES_SWAPPED"],
  ];
  for (const [point, phase] of kills) {
    const op = nextOp();
    const killed = ops(["restore", "ensaio-1", "--confirm-offline"], {
      allowFailure: true,
      env: { WHITEOVEN_TEST_KILL_AT: point, WHITEOVEN_TEST_OPERATION_ID: op },
    });
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(opState(op).phase, phase, "last phase durable on disk");
    assert.equal(lockHeld(), true, "a killed process leaves its lock");
    if (point === "after_db_swap") {
      // Host reboot: PostgreSQL restarts; the block lives in the database, not in the process.
      compose("restart", "postgres");
      compose("up", "-d", "--wait", "postgres");
      const started = run(
        "docker",
        [
          "compose",
          "-f",
          "compose.dev.yaml",
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "40",
          "api",
        ],
        { allowFailure: true },
      );
      assert.notEqual(started.status, 0, "the API must not become ready");
      const ready = await fetch(
        `http://127.0.0.1:${apiPort}/health/ready`,
      ).catch(() => null);
      assert.notEqual(ready?.status, 200);
      compose("stop", "api");
    }
    assert.equal(appCanConnect(), "f", "the API role cannot connect");
    assert.match(
      ops(["restore-status"]).stdout,
      new RegExp(`${op} fase=${phase} .*\\[PENDENTE\\]`),
    );
    const blocked = refused(
      ["restore", "ensaio-1", "--confirm-offline"],
      /Há restauração incompleta/,
    );
    assert.match(blocked.stderr, /Lock deixado pelo processo/);
    ops(["restore-rollback", op]);
    assertClosed(op, "ROLLED_BACK");
    assertLiveIntact();
  }
  record.scenarios.push({
    name: "processo morto durante a troca",
    points: kills.map(([point]) => point),
    checks: [
      "fase gravada em disco; restore-status mostra a operação pendente",
      "CONNECT do papel da API revogado: a API não fica pronta, inclusive após reiniciar o PostgreSQL",
      "lock órfão retomado; restore-rollback devolve o conjunto original",
    ],
  });

  // 5b. The rollback itself fails or dies: the API stays blocked until the set is consistent.
  {
    const op = nextOp();
    const failed = refused(
      ["restore", "ensaio-1", "--confirm-offline"],
      /Rollback automático falhou/,
      {
        WHITEOVEN_TEST_FAIL_AT: "after_db_swap",
        WHITEOVEN_TEST_ROLLBACK_FAIL_AT: "rollback_images_done",
        WHITEOVEN_TEST_OPERATION_ID: op,
      },
    );
    assert.match(failed.stderr, /Falha injetada no rollback/);
    let s = opState(op);
    assert.equal(s.phase, "ROLLBACK_FAILED");
    assert.equal(s.rollback_attempts, "1");
    assert.equal(lockHeld(), false);
    // Original images are back, but the restored database still has the live name.
    assert.equal(
      dbComment("whiteoven"),
      `whiteoven-restore candidate op=${op}`,
    );
    assert.equal(appCanConnect(), "f", "a half rollback never opens the API");
    assert.match(
      readFileSync(join(state, "api-restores", op, "rollback.log"), "utf8"),
      /tentativa 1 .* status=1[\s\S]*Falha injetada no rollback/,
    );
    assert.match(
      ops(["restore-status"]).stdout,
      new RegExp(`${op} fase=ROLLBACK_FAILED .*\\[PENDENTE\\]`),
    );
    // The original set is damaged meanwhile: the retry puts the database back but must refuse
    // to open the API while a referenced image is truncated.
    const path = menuPath(tenantId, image2.id);
    const original = volumeFiles().get(path);
    inApi(
      `set -eu; f=${IMAGES}/${path}; head -c 200 "$f" > "$f.cut"; cat "$f.cut" > "$f"; rm "$f.cut"`,
    );
    refused(["restore-rollback", op], /não confere[\s\S]*ROLLBACK_FAILED/);
    s = opState(op);
    assert.equal(s.phase, "ROLLBACK_FAILED");
    assert.equal(s.rollback_attempts, "2");
    assert.equal(dbComment("whiteoven"), `whiteoven-restore previous op=${op}`);
    assert.equal(appCanConnect(), "f");
    inApi(`cat > ${IMAGES}/${path}`, original);
    ops(["restore-rollback", op]);
    assertClosed(op, "ROLLED_BACK");
    assert.equal(opState(op).rollback_attempts, "3");
    assertLiveIntact();
  }
  {
    const op = nextOp();
    const killed = ops(["restore", "ensaio-1", "--confirm-offline"], {
      allowFailure: true,
      env: {
        WHITEOVEN_TEST_FAIL_AT: "images_swap",
        WHITEOVEN_TEST_ROLLBACK_KILL_AT: "rollback_db_done",
        WHITEOVEN_TEST_OPERATION_ID: op,
      },
    });
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(
      opState(op).phase,
      "ROLLING_BACK",
      "rollback in progress on disk",
    );
    assert.equal(
      appCanConnect(),
      "f",
      "a rollback killed midway keeps the API out",
    );
    assert.match(
      ops(["restore-status"]).stdout,
      new RegExp(`${op} fase=ROLLING_BACK .*\\[PENDENTE\\]`),
    );
    ops(["restore-rollback", op]);
    assertClosed(op, "ROLLED_BACK");
    assertLiveIntact();
  }
  up();
  assert.equal(await loginStatus(c), 200);
  record.scenarios.push({
    name: "falha e morte durante o rollback",
    checks: [
      "rollback com falha injetada: ROLLBACK_FAILED, evidência em rollback.log, API sem CONNECT",
      "nova tentativa com imagem original truncada: banco devolvido, mas acesso continua bloqueado até o conjunto conferir",
      "rollback morto no meio: ROLLING_BACK em disco, API sem CONNECT; terceira tentativa conclui",
    ],
  });

  // 6. Two full restores.
  const full = [];
  for (const label of ["primeira", "segunda"]) {
    const op = nextOp();
    start = Date.now();
    const restored = ops(["restore", "ensaio-1", "--confirm-offline"], {
      env: { WHITEOVEN_TEST_OPERATION_ID: op },
    });
    const restoreSeconds = seconds(start);
    start = Date.now();
    up();
    const restartSeconds = seconds(start);
    assert.equal(customerStatus(a.id), "DELETED:true", "A's deletion survived");
    assert.equal(customerStatus(z.id), "DELETED:true");
    assert.equal(await loginStatus(a), 401);
    assert.equal(await loginStatus(z), 401);
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
    const files = volumeFiles();
    const referenced = assertReferencedImagesComplete(files);
    assert.equal(sha(files.get(menuPath(tenantId, image1.id))), image1.sha);
    const restoredIds = new Set(sql("select id from image_assets").split("\n"));
    let concurrentRestored = 0;
    for (const image of concurrent)
      if (restoredIds.has(image.id)) {
        concurrentRestored += 1;
        assert.equal(sha(files.get(menuPath(tenantId, image.id))), image.sha);
      }
    assert.equal(files.get(menuPath(tenantId, image2.id)), undefined);
    const s = opState(op);
    assert.equal(s.phase, "COMPLETE");
    assert.equal(dbComment("whiteoven"), `whiteoven-restore restored op=${op}`);
    if (label === "primeira") {
      assert.equal(
        sha(volumeFiles(`${s.aside}/`).get(menuPath(tenantId, image2.id))),
        image2.sha,
        "newer image kept aside",
      );
      assert.equal(
        sql(`select count(*) from customers where id = '${c.id}'`, s.previous),
        "1",
        "newer data kept in the previous database",
      );
    }
    assert.ok(existsSync(join(backups, `pre-restore-${op}`)));
    full.push({ op, s });
    record.scenarios.push({
      name: `restauração completa (${label})`,
      restoreSeconds,
      restartSeconds,
      referencedImages: referenced,
      concurrentUploadsRestored: concurrentRestored,
      log: restored.stdout.match(/restore op=.*/)[0],
    });
  }
  assert.notEqual(full[0].s.candidate, full[1].s.candidate);
  assert.equal(
    dbComment(full[0].s.previous),
    `whiteoven-restore previous op=${full[0].op}`,
    "the first restore's previous database is not reused",
  );
  refused(["restore-rollback", full[1].op], /foi concluída/);
  for (const { op } of full) ops(["restore-cleanup", op]);
  assert.equal(restoreDatabases(), "");
  assert.deepEqual(volumeEntries(), ["tenants"]);
  for (const { op } of full) assert.equal(opState(op).phase, "CLEANED");
  record.scenarios.at(-1).checks = [
    "exclusões anteriores e posteriores à cópia mantidas (DELETED, sem e-mail, login 401, sem endereço)",
    "toda imagem referenciada existe e está completa; imagens dos uploads concorrentes idênticas byte a byte",
    "candidatos distintos por operação; banco anterior de cada uma preservado até restore-cleanup",
  ];

  // 7a. The live database replaced, outside this tool, by an older state of the same lineage
  // (the backup's own dump, without the later deletion). Its chain is intact and contains the
  // backup's head, but not what this host already saw.
  const oldLineage = record.backupManifest.lineage;
  const recreateDb = () => {
    compose("stop", "api");
    compose("exec", "-T", "postgres", "dropdb", "-U", "postgres", "whiteoven");
    compose(
      "exec",
      "-T",
      "postgres",
      "createdb",
      "-U",
      "postgres",
      "-O",
      "whiteoven_owner",
      "whiteoven",
    );
  };
  recreateDb();
  run(
    "docker",
    [
      "compose",
      "-f",
      "compose.dev.yaml",
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "whiteoven",
      "--single-transaction",
    ],
    { input: readFileSync(join(backups, "ensaio-1", "database.dump")) },
  );
  assert.equal(sql("select id from database_lineage"), oldLineage);
  assert.equal(
    customerStatus(a.id),
    "ACTIVE:false",
    "older state: A not deleted",
  );
  const warned = ops(["export-erasures", join(work, "ledger-rolled-back")]);
  assert.match(
    warned.stderr,
    /AVISO: o diário de exclusões do banco atual não contém/,
  );
  {
    const op = nextOp();
    refused(["restore", "ensaio-1", "--confirm-offline"], /ERASURES_STALE/, {
      WHITEOVEN_TEST_OPERATION_ID: op,
    });
    ops(["restore-rollback", op]);
    assertClosed(op, "ROLLED_BACK");
  }
  record.scenarios.push({
    name: "banco trocado por estado anterior da mesma linhagem",
    checks: [
      "export-erasures avisa que o banco não contém o último estado visto",
      "restore sem diário recusado com ERASURES_STALE, apesar da cadeia íntegra e contínua com a cópia",
    ],
  });

  // 7b. The database recreated in the same cluster (new lineage, no deletions known).
  recreateDb();
  up();
  assert.notEqual(sql("select id from database_lineage"), oldLineage);
  ops(["export-erasures", join(work, "ledger-other")]);
  const ledgerOther = ledgerOf("ledger-other");
  const lines = readFileSync(ledgerAfter, "utf8").split("\n");
  const ledgerTampered = join(work, "tampered.csv");
  writeFileSync(
    ledgerTampered,
    [
      ...lines.slice(0, 3),
      lines[3].replace(/,(.)/, (_, ch) => `,${ch === "a" ? "b" : "a"}`),
      ...lines.slice(4),
    ].join("\n"),
  );
  // Row 1 removed and row 2 renumbered as 1, header adjusted: the format holds, the chain does not.
  const [, , row1, row2] = lines;
  const gapRow = row2.replace(/^2,/, "1,");
  const ledgerGap = join(work, "gap.csv");
  writeFileSync(
    ledgerGap,
    `${lines[0].replace(/head=2 head_hash=[0-9a-f]+/, `head=1 head_hash=${gapRow.split(",").at(-1)}`)}\n${lines[1]}\n${gapRow}\n`,
  );
  assert.ok(row1);
  const ledgerIncomplete = join(work, "incomplete.csv");
  writeFileSync(ledgerIncomplete, `${lines.slice(0, 3).join("\n")}\n`);
  const sameCluster = [
    [[], /ERASURES_MISSING/],
    [
      ["--erasures", ledgerOther],
      /ERASURES_LEDGER_INVALID: o diário é da linhagem/,
    ],
    [["--erasures", ledgerTampered], /ERASURES_LEDGER_INVALID: o encadeamento/],
    [["--erasures", ledgerGap], /ERASURES_LEDGER_INVALID: o encadeamento/],
    [["--erasures", ledgerBefore], /não contém o estado da cópia/],
    [["--erasures", ledgerAtBackup], /ERASURES_STALE/],
    // Valid and continuous, but nothing shows it holds deletions after its export.
    [["--erasures", ledgerAfter], /ERASURES_CUTOFF_UNCONFIRMED/],
    [
      [
        "--erasures",
        ledgerAfter,
        "--accept-erasures-until",
        "20200101T000000Z",
      ],
      /ERASURES_CUTOFF_UNCONFIRMED/,
    ],
  ];
  for (const [extra, pattern] of sameCluster) {
    const op = nextOp();
    refused(["restore", "ensaio-1", "--confirm-offline", ...extra], pattern, {
      WHITEOVEN_TEST_OPERATION_ID: op,
    });
    assert.equal(opState(op).phase, "FAILED");
    ops(["restore-rollback", op]);
    assertClosed(op, "ROLLED_BACK");
  }
  const before = readdirSync(join(state, "api-restores")).length;
  refused(
    [
      "restore",
      "ensaio-1",
      "--confirm-offline",
      "--erasures",
      ledgerIncomplete,
    ],
    /incompleto/,
  );
  assert.equal(
    readdirSync(join(state, "api-restores")).length,
    before,
    "refused before any operation",
  );
  start = Date.now();
  const recreated = ops([
    "restore",
    "ensaio-1",
    "--confirm-offline",
    "--erasures",
    ledgerAfter,
    ...ackAfter,
  ]);
  const recreatedSeconds = seconds(start);
  up();
  assert.equal(customerStatus(a.id), "DELETED:true");
  assert.equal(customerStatus(z.id), "DELETED:true");
  assert.equal(await loginStatus(a), 401);
  assert.equal(await loginStatus(b), 200);
  assert.equal(sql("select id from database_lineage"), oldLineage);
  record.scenarios.push({
    name: "banco recriado no mesmo cluster",
    restoreSeconds: recreatedSeconds,
    log: recreated.stdout.match(/restore op=.*/)[0],
    checks: [
      "sem diário: ERASURES_MISSING (banco atual de outra linhagem)",
      "diário de outra linhagem, adulterado, com registro intermediário ausente, anterior à cópia ou anterior ao último estado visto no host: recusados",
      "diário válido sem confirmação do corte (ou com data errada): ERASURES_CUTOFF_UNCONFIRMED",
      "diário incompleto recusado antes de qualquer operação",
      "diário válido e contínuo, com o corte confirmado, aprovado; exclusões mantidas",
    ],
  });

  // 8. Host lost: only the backups and the external ledger survive. Fresh cluster and volume:
  // the database is the empty one migrate created and there is no tenants directory.
  compose("down", "-v");
  rmSync(state, { recursive: true, force: true });
  up();
  assert.deepEqual(volumeEntries(), []);
  const withLedger = ["--erasures", ledgerAfter, ...ackAfter];
  const freshFails = [
    [[], /ERASURES_MISSING/, {}],
    [["--erasures", ledgerAfter], /ERASURES_CUTOFF_UNCONFIRMED/, {}],
    [
      withLedger,
      /Rollback concluído/,
      { WHITEOVEN_TEST_FAIL_AT: "after_db_swap" },
    ],
    [
      withLedger,
      /Rollback concluído/,
      { WHITEOVEN_TEST_FAIL_AT: "images_swap" },
    ],
  ];
  for (const [extra, pattern, extraEnv] of freshFails) {
    const op = nextOp();
    refused(["restore", "ensaio-1", "--confirm-offline", ...extra], pattern, {
      ...extraEnv,
      WHITEOVEN_TEST_OPERATION_ID: op,
    });
    if (opState(op).phase !== "ROLLED_BACK") ops(["restore-rollback", op]);
    // The rollback must not create a tenants directory that did not exist.
    assertClosed(op, "ROLLED_BACK", []);
    assert.equal(appCanConnect(), "t");
    assert.equal(
      sql("select count(*) from customers"),
      "0",
      "empty database back",
    );
  }
  {
    // Killed after the database swap, then recovered by hand as the runbook says.
    const op = nextOp();
    const killed = ops(
      ["restore", "ensaio-1", "--confirm-offline", ...withLedger],
      {
        allowFailure: true,
        env: {
          WHITEOVEN_TEST_KILL_AT: "after_db_swap",
          WHITEOVEN_TEST_OPERATION_ID: op,
        },
      },
    );
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(appCanConnect(), "f");
    assert.equal(
      dbComment("whiteoven"),
      `whiteoven-restore candidate op=${op}`,
    );
    const psql = (command) =>
      compose(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        command,
      );
    psql(`alter database "whiteoven" rename to "whiteoven_rc_${op}"`);
    psql(`alter database "whiteoven_prev_${op}" rename to "whiteoven"`);
    psql(
      'grant connect on database "whiteoven" to whiteoven_app, whiteoven_platform',
    );
    psql('comment on database "whiteoven" is null');
    ops(["restore-rollback", op]);
    assertClosed(op, "ROLLED_BACK", []);
    assert.equal(sql("select count(*) from customers"), "0");
  }
  {
    // No original database at all.
    compose("stop", "api");
    compose("exec", "-T", "postgres", "dropdb", "-U", "postgres", "whiteoven");
    const op = nextOp();
    refused(
      ["restore", "ensaio-1", "--confirm-offline", ...withLedger],
      /Rollback concluído/,
      {
        WHITEOVEN_TEST_FAIL_AT: "after_db_swap",
        WHITEOVEN_TEST_OPERATION_ID: op,
      },
    );
    assert.equal(opState(op).live_existed, "no");
    assertClosed(op, "ROLLED_BACK", []);
    assert.equal(
      sql(
        "select count(*) from pg_database where datname = 'whiteoven'",
        "postgres",
      ),
      "0",
      "nothing left under the live name",
    );
  }
  start = Date.now();
  const recovered = ops([
    "restore",
    "ensaio-1",
    "--confirm-offline",
    ...withLedger,
  ]);
  const recoverSeconds = seconds(start);
  up();
  assert.equal(
    customerStatus(a.id),
    "DELETED:true",
    "the ledger carried A's deletion",
  );
  assert.equal(await loginStatus(a), 401);
  assert.equal(await loginStatus(b), 200);
  const recoveredFiles = volumeFiles();
  assertReferencedImagesComplete(recoveredFiles);
  assert.equal(
    sha(recoveredFiles.get(menuPath(tenantId, image1.id))),
    image1.sha,
  );
  assert.notEqual(
    sql(
      "select count(*) from pg_stat_activity where usename = 'whiteoven_app'",
    ),
    "0",
    "the API connects as whiteoven_app",
  );
  record.scenarios.push({
    name: "perda do host",
    restoreSeconds: recoverSeconds,
    log: recovered.stdout.match(/restore op=.*/)[0],
    checks: [
      "restore sem diário recusado com ERASURES_MISSING; sem confirmar o corte, ERASURES_CUTOFF_UNCONFIRMED",
      "falhas depois da troca do banco e durante a troca das imagens: rollback sem criar tenants nem apagar o banco vazio",
      "morte depois da troca do banco: recuperação manual do runbook e restore-rollback",
      "sem banco original: rollback não deixa nada sob o nome do banco",
      "nova tentativa depois dos rollbacks reaplica a exclusão em cluster novo",
      "API volta saudável como whiteoven_app; imagens referenciadas completas",
    ],
  });

  // 9. A committed image corrupted inside (RIFF size intact), then one truncated: the backup
  // refuses both.
  {
    const victim = concurrent.find(
      (image) =>
        sql(`select count(*) from image_assets where id = '${image.id}'`) ===
        "1",
    );
    const path = menuPath(tenantId, victim.id);
    const bytes = volumeFiles().get(path);
    assert.equal(bytes.toString("latin1", 12, 16), "VP8 ");
    inApi(
      `set -eu; printf '\\000\\000\\000' | dd of=${IMAGES}/${path} bs=1 seek=23 conv=notrunc 2>/dev/null`,
    );
    assert.equal(volumeFiles().get(path).length, bytes.length);
    const corrupted = refused(
      ["backup", "ensaio-corrompida"],
      /Backup recusado/,
    );
    assert.match(corrupted.stderr, /quadro VP8/);
    assert.equal(existsSync(join(backups, "ensaio-corrompida")), false);
    inApi(`cat > ${IMAGES}/${path}`, bytes);
  }
  inApi(
    `set -eu; f=${IMAGES}/${menuPath(tenantId, image1.id)}; head -c 100 "$f" > "$f.cut"; cat "$f.cut" > "$f"; rm "$f.cut"`,
  );
  refused(["backup", "ensaio-truncada"], /Backup recusado/);
  assert.equal(existsSync(join(backups, "ensaio-truncada")), false);
  record.scenarios.push({
    name: "imagem truncada",
    checks: [
      "conteúdo interno corrompido com tamanho RIFF correto: backup recusado",
      "backup recusado e nada gravado quando uma imagem referenciada está incompleta",
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
