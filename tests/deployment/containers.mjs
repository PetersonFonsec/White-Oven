import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { CONSENT_VERSION } from "../../packages/contracts/src/leads.ts";
const root = resolve(import.meta.dirname, "../..");
const image = process.env.WHITEOVEN_TEST_IMAGE ?? "whiteoven:m02-test";
const project = `wotest-${randomUUID().slice(0, 8)}`;
const temporary = mkdtempSync(join(tmpdir(), "whiteoven-container-"));
const config = join(temporary, "config.env");
const subnet = `172.29.${Math.floor(Math.random() * 200) + 10}`;
const env = {
  ...process.env,
  WHITEOVEN_ENV_FILE: config,
  WHITEOVEN_STATE_DIR: join(temporary, "state"),
  WHITEOVEN_WAIT_SECONDS: "40",
  COMPOSE_PROJECT_NAME: project,
};
const run = (args, options = {}) =>
  execFileSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024,
    env,
    ...options,
  }).trim();
const compose = (...args) =>
  run([
    "compose",
    "--project-name",
    project,
    "--env-file",
    config,
    "-f",
    "compose.yaml",
    ...args,
  ]);
const ops = (...args) =>
  execFileSync("bash", ["ops/whiteoven.sh", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 24 * 1024 * 1024,
  }).trim();
const port = await new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
let selected = image;
function configuration(extra = {}) {
  const values = {
    WHITEOVEN_IMAGE: selected,
    WHITEOVEN_PORT: port,
    WHITEOVEN_ENV_FILE: config,
    WHITEOVEN_SUBNET: `${subnet}.0/24`,
    WHITEOVEN_DOMAIN: "whiteoven.synthetic.test",
    CADDY_INTERNAL_IP: `${subnet}.3`,
    LEADS_ENABLED: "true",
    SITE_ORIGIN: "https://whiteoven.synthetic.test",
    LEADS_CONTROLLER_NAME: "Synthetic Test Controller",
    LEADS_PRIVACY_EMAIL: "privacy@example.test",
    LEADS_TRUSTED_PROXIES: `${subnet}.3`,
    SECRET_CANARY: "synthetic-secret-never-log",
    ...extra,
  };
  writeFileSync(
    config,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
}
const container = () => compose("ps", "-q", "landing");
const inside = (code, input) =>
  run(
    [
      "exec",
      "-i",
      container(),
      "node",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      code,
    ],
    { input },
  );
const request = (path, body) =>
  JSON.parse(
    inside(
      `let input='';for await(const part of process.stdin)input+=part; const response=await fetch('http://127.0.0.1:4321${path}',{method:input?'POST':'GET',headers:{Origin:'https://whiteoven.synthetic.test','Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},...(input?{body:input}:{})}); console.log(JSON.stringify({status:response.status,body:await response.json()}));`,
      body ? JSON.stringify(body) : "",
    ),
  );
const count = () =>
  Number(
    inside(
      `import Database from 'better-sqlite3';const db=new Database(process.env.LEADS_DB_PATH,{readonly:true});console.log(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n);db.close();`,
    ),
  );
const fixture = () => ({
  responsibleName: "Synthetic Person",
  pizzeriaName: "Synthetic Pizza",
  whatsapp: "11999999999",
  monthlyOrderVolume: "UP_TO_300",
  interestedPlan: "FLEX",
  contactConsent: true,
  consentVersion: CONSENT_VERSION,
  website: "",
  attribution: {
    utm_source: "container-test",
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    referrer: null,
    landingPath: "/",
  },
  funnel: { pizzaBuilderInteracted: false, planCtaClicked: false },
});
const extras = [];
try {
  run(["version"]);
  if (process.env.WHITEOVEN_SKIP_BUILD !== "1")
    run([
      "build",
      "--build-arg",
      `VCS_REF=${process.env.GITHUB_SHA ?? "local-m02"}`,
      "-t",
      image,
      ".",
    ]);
  console.log("PASS Docker build");
  configuration();
  compose("-f", "ops/compose.caddy.yaml", "config", "--quiet");
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90");
  assert.equal(run(["exec", container(), "id", "-u"]), "1000");
  assert.equal(
    run(["exec", container(), "sh", "-c", "command -v g++ || true"]),
    "",
  );
  assert.equal(
    run([
      "exec",
      container(),
      "sh",
      "-c",
      "test ! -e .env && test ! -d node_modules/@astrojs/check && echo clean",
    ]),
    "clean",
  );
  assert.equal(request("/health/live").status, 200);
  assert.deepEqual(request("/health/ready").body, {
    ready: true,
    capture: "enabled",
    storage: "ready",
  });
  const first = request("/api/leads", fixture());
  assert.equal(first.status, 201);
  const submissionLogs = run(["logs", container()]);
  for (const canary of [
    "Synthetic Person",
    "Synthetic Pizza",
    "11999999999",
    "synthetic-secret-never-log",
  ])
    assert.ok(!submissionLogs.includes(canary));
  assert.equal(count(), 1);
  const before = inside(
    `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';console.log(createHash('sha256').update(readFileSync(process.env.LEADS_DB_PATH)).digest('hex'));`,
  );
  for (let i = 0; i < 3; i++)
    assert.equal(request("/health/ready").status, 200);
  const after = inside(
    `import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';console.log(createHash('sha256').update(readFileSync(process.env.LEADS_DB_PATH)).digest('hex'));`,
  );
  assert.equal(before, after);
  assert.equal(count(), 1);
  console.log("PASS non-root, liveness/readiness and health without DB writes");
  compose(
    "up",
    "-d",
    "--force-recreate",
    "--no-build",
    "--wait",
    "--wait-timeout",
    "90",
  );
  assert.equal(count(), 1);
  const updateFile = join(temporary, "Dockerfile.update");
  writeFileSync(
    updateFile,
    `FROM ${image}\nLABEL whiteoven.test.version="update"\n`,
  );
  run([
    "build",
    "--quiet",
    "-f",
    updateFile,
    "-t",
    `${image}-update`,
    temporary,
  ]);
  selected = `${image}-update`;
  configuration();
  ops("update");
  assert.equal(count(), 1);
  ops("verify");
  ops("update");
  console.log(
    "PASS SQLite persistence after recreation and idempotent version update",
  );
  // Image rollback only; a lead committed after the update must survive.
  const newer = { ...fixture(), pizzeriaName: "Synthetic Pizza After Update" };
  assert.equal(request("/api/leads", newer).status, 201);
  ops("rollback");
  assert.equal(count(), 2);
  console.log("PASS image rollback preserves post-update leads");
  // A deliberately broken image must recover the previous image, never a database snapshot.
  const brokenFile = join(temporary, "Dockerfile.broken");
  writeFileSync(
    brokenFile,
    `FROM ${image}\nCMD ["node", "-e", "process.exit(1)"]\n`,
  );
  const broken = `${image}-broken`;
  run(["build", "--quiet", "-f", brokenFile, "-t", broken, temporary]);
  selected = broken;
  configuration();
  assert.throws(() => ops("update"));
  assert.equal(request("/health/ready").status, 200);
  assert.equal(count(), 2);
  selected = image;
  configuration();
  console.log(
    "PASS failed update recovers previous healthy image without rewinding SQLite",
  );

  ops("ledger-init");
  ops("backup", "synthetic");
  ops("verify-backup", "synthetic");
  ops("backup", "synthetic");
  ops("exclude", first.body.leadId);
  // Controlled restore keeps a safety backup and reapplies the current deletion ledger.
  ops("restore", "synthetic", "--confirm-offline");
  assert.equal(compose("ps", "--status", "running", "-q", "landing"), "");
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90");
  assert.equal(count(), 1);
  ops("purge");
  assert.equal(
    inside(
      `import {readdirSync} from 'node:fs';console.log(readdirSync('/var/backups/whiteoven').some(name=>name.startsWith('before-restore-')));`,
    ),
    "true",
  );
  console.log(
    "PASS consistent backup, controlled restore, deletions and purge",
  );
  const id = container();
  const { request: httpRequest } = await import("node:http");
  const payload = Buffer.from(
    JSON.stringify({ ...fixture(), pizzeriaName: "Synthetic During Shutdown" }),
  );
  let finishBody;
  const responseDuringShutdown = new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/leads",
        method: "POST",
        headers: {
          Origin: "https://whiteoven.synthetic.test",
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          "Idempotency-Key": randomUUID(),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", reject);
    req.setTimeout(7000, () =>
      req.destroy(new Error("Graceful shutdown deadline failed")),
    );
    const midpoint = Math.floor(payload.length / 2);
    req.write(payload.subarray(0, midpoint));
    finishBody = () => req.end(payload.subarray(midpoint));
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  run(["kill", "--signal=TERM", id]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  finishBody();
  assert.equal(await responseDuringShutdown, 201);
  assert.equal(run(["wait", id]), "0");
  const state = JSON.parse(run(["inspect", "--format", "{{json .State}}", id]));
  assert.equal(state.ExitCode, 0);
  assert.equal(state.OOMKilled, false);
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90");
  assert.equal(count(), 2);
  console.log("PASS SIGTERM drains an in-flight lead and exits cleanly");
  configuration({
    LEADS_ENABLED: "false",
    LEADS_CONTROLLER_NAME: "",
    LEADS_PRIVACY_EMAIL: "",
  });
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90");
  assert.equal(request("/health/ready").body.capture, "disabled");
  assert.equal(request("/api/leads", fixture()).status, 503);
  configuration({ LEADS_CONTROLLER_NAME: "", LEADS_PRIVACY_EMAIL: "" });
  compose("up", "-d", "--no-build");
  // Readiness must report incomplete requested capture without taking liveness down.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(request("/health/live").status, 200);
  assert.equal(request("/health/ready").status, 503);
  assert.equal(request("/api/leads", fixture()).status, 503);
  configuration();
  compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90");
  console.log("PASS incomplete capture fails closed");
  const logs = run(["logs", container()]);
  for (const canary of [
    "Synthetic Person",
    "Synthetic Pizza",
    "11999999999",
    "synthetic-secret-never-log",
    "privacy@example.test",
  ])
    assert.ok(!logs.includes(canary));
  console.log("PASS no PII or secret canaries in application logs");
  // Exercise the shipped Caddy configuration and the exact static proxy peer.
  const network = JSON.parse(
    run([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      container(),
    ]),
  );
  const networkName = Object.keys(network)[0];
  const echo = `${project}-echo`,
    proxy = `${project}-caddy`;
  extras.push(proxy, echo);
  const echoScript = `import {createCaptureServer} from './src/server/http-server.ts';import {getRequestClient} from './src/server/request-context.ts';createCaptureServer(async(req,res)=>{try{for await(const chunk of req)void chunk;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({peer:req.socket.remoteAddress,client:getRequestClient(),origin:req.headers.origin,forwarded:req.headers['x-forwarded-for']}));}catch{res.destroy();}},new Set(['${subnet}.3'])).listen(4321,'0.0.0.0');`;
  run([
    "run",
    "-d",
    "--name",
    echo,
    "--network",
    networkName,
    "--ip",
    `${subnet}.10`,
    "--entrypoint",
    "node",
    image,
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    echoScript,
  ]);
  run([
    "run",
    "-d",
    "--name",
    proxy,
    "--network",
    networkName,
    "--ip",
    `${subnet}.3`,
    "-p",
    "127.0.0.1::8080",
    "-e",
    "WHITEOVEN_DOMAIN=http://:8080",
    "-e",
    `WHITEOVEN_UPSTREAM=${echo}:4321`,
    "-v",
    `${root}/ops/Caddyfile:/etc/caddy/Caddyfile:ro`,
    "caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f",
  ]);
  const address = run(["port", proxy, "8080/tcp"]);
  let response;
  for (let i = 0; i < 30; i++) {
    try {
      response = await fetch(`http://${address}/`, {
        headers: {
          "X-Forwarded-For": "198.51.100.77",
          Origin: "https://synthetic.test",
        },
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  assert.ok(response?.ok);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.ok(response.headers.get("strict-transport-security"));
  const identity = await response.json();
  assert.equal(identity.peer, `${subnet}.3`);
  assert.notEqual(identity.client, identity.peer);
  assert.notEqual(identity.client, "198.51.100.77");
  assert.equal(identity.forwarded, undefined);
  assert.equal(identity.origin, "https://synthetic.test");
  assert.equal((await fetch(`http://${address}/health/ready`)).status, 404);
  assert.equal(
    (
      await fetch(`http://${address}/api/leads`, {
        method: "POST",
        body: "x".repeat(8193),
      })
    ).status,
    413,
  );
  console.log(
    "PASS shipped Caddy config, trusted peer, spoof protection, headers and body limit",
  );
  console.log("Container validation completed with synthetic data only.");
} finally {
  for (const name of extras)
    try {
      run(["rm", "-f", "-v", name]);
    } catch {
      /* Only owned test containers. */
    }
  try {
    compose("down", "--volumes", "--remove-orphans");
  } catch {
    /* Preserve original failure. */
  }
  rmSync(temporary, { recursive: true, force: true });
}
