// Exercises the operational scripts' decisions against a recording docker/gh/curl double,
// so failure paths that need a broken registry or host are covered without Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const stubs = join(import.meta.dirname, "stubs");
function harness() {
  const state = mkdtempSync(join(tmpdir(), "whiteoven-ops-"));
  const envFile = join(state, "ops.env");
  const configure = (image) =>
    writeFileSync(envFile, `WHITEOVEN_IMAGE=${image}\nLEADS_ENABLED=false\n`);
  const run = (script, args = [], extra = {}) => {
    const result = spawnSync("bash", [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${stubs}:${process.env.PATH}`,
        STUB_STATE: state,
        WHITEOVEN_ENV_FILE: envFile,
        WHITEOVEN_STATE_DIR: join(state, "ops-state"),
        ...extra,
      },
    });
    return { ...result, log: () => readFileSync(join(state, "log"), "utf8") };
  };
  const ops = (...args) => run("ops/whiteoven.sh", args);
  const mark = (file, value) =>
    writeFileSync(join(state, file), `${value}\n`, { flag: "a" });
  const running = () =>
    existsSync(join(state, "running"))
      ? readFileSync(join(state, "running"), "utf8").trim()
      : null;
  const stateFile = (name) => {
    const path = join(state, "ops-state", name);
    return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
  };
  const cleanup = () => rmSync(state, { recursive: true, force: true });
  return { state, configure, run, ops, mark, running, stateFile, cleanup };
}
test("failed update reports a healthy recovery and blocks redeploying the failed image", () => {
  const h = harness();
  try {
    h.configure("app:v1");
    assert.equal(h.ops("update").status, 0);
    h.configure("app:v2");
    h.mark("unhealthy", "sha256:appv2");
    const failed = h.ops("update");
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /recuperada e saudável/);
    assert.equal(h.running(), "sha256:appv1");
    assert.equal(h.stateFile("failed-image"), "sha256:appv2");
    const again = h.ops("update");
    assert.equal(again.status, 1);
    assert.match(again.stderr, /falhou ou foi revertida/);
    assert.equal(h.running(), "sha256:appv1");
    h.configure("app:v1");
    assert.equal(h.ops("update").status, 0);
    h.configure("app:v3");
    assert.equal(h.ops("update").status, 0);
    assert.equal(h.stateFile("failed-image"), null);
    assert.equal(h.stateFile("previous-image"), "sha256:appv1");
  } finally {
    h.cleanup();
  }
});
test("update distinguishes a failed recovery and a first install without a previous image", () => {
  const h = harness();
  try {
    h.configure("app:v1");
    h.mark("unhealthy", "sha256:appv1");
    const first = h.ops("update");
    assert.equal(first.status, 2);
    assert.match(first.stderr, /não havia versão anterior/);
    assert.equal(h.running(), null);
    rmSync(join(h.state, "unhealthy"));
    rmSync(join(h.state, "ops-state", "failed-image"));
    assert.equal(h.ops("update").status, 0);
    h.configure("app:v2");
    h.mark("unhealthy", "sha256:appv2");
    h.mark("unhealthy", "sha256:appv1");
    const both = h.ops("update");
    assert.equal(both.status, 2);
    assert.match(both.stderr, /também falhou: serviço indisponível/);
  } finally {
    h.cleanup();
  }
});
test("rollback validates the previous image against current configuration and pins the outcome", () => {
  const h = harness();
  try {
    h.configure("app:v1");
    h.ops("update");
    h.configure("app:v2");
    h.ops("update");
    h.mark("invalid", "sha256:appv1");
    const refused = h.ops("rollback");
    assert.notEqual(refused.status, 0);
    assert.equal(h.running(), "sha256:appv2");
    assert.match(
      refused.log(),
      /run --rm --env-file \S+ --entrypoint node sha256:appv1/,
    );
    rmSync(join(h.state, "invalid"));
    const rolled = h.ops("rollback");
    assert.equal(rolled.status, 0);
    assert.match(rolled.stdout, /Fixe WHITEOVEN_IMAGE=sha256:appv1/);
    assert.equal(h.running(), "sha256:appv1");
    assert.equal(h.stateFile("failed-image"), "sha256:appv2");
    // Restore and update keep refusing the reverted image until ops/.env changes.
    assert.match(
      h.ops("restore", "synthetic", "--confirm-offline").stderr,
      /falhou ou foi revertida/,
    );
    assert.equal(h.running(), "sha256:appv1");
    assert.equal(h.ops("update").status, 1);
  } finally {
    h.cleanup();
  }
});
test("unhealthy rollback brings back the image that was running", () => {
  const h = harness();
  try {
    h.configure("app:v1");
    h.ops("update");
    h.configure("app:v2");
    h.ops("update");
    h.mark("unhealthy", "sha256:appv1");
    const result = h.ops("rollback");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Imagem sha256:appv2 recuperada e saudável/);
    assert.equal(h.running(), "sha256:appv2");
  } finally {
    h.cleanup();
  }
});
test("delete records the exclusion before removing the lead", () => {
  const h = harness();
  try {
    h.configure("app:v1");
    const id = "0b1f6a5e-6f2d-4c4b-9a43-2b8f5b9d6c11";
    assert.equal(h.ops("delete", id).status, 0);
    const log = h.ops("status").log();
    const exclude = log.indexOf(`storage.mjs exclude ${id}`);
    const remove = log.indexOf(`leads.mjs delete ${id}`);
    assert.ok(exclude >= 0 && remove > exclude);
    assert.notEqual(h.ops("delete", "not-a-uuid").status, 0);
  } finally {
    h.cleanup();
  }
});
test("export writes one complete bundle atomically and never leaves partial plaintext", () => {
  const h = harness();
  try {
    h.configure("app:v1");
    const out = join(h.state, "external");
    h.mark("export-fails", "");
    assert.notEqual(h.ops("export-backup", "offsite", out).status, 0);
    assert.deepEqual(readdirSync(out), []);
    rmSync(join(h.state, "export-fails"));
    assert.equal(h.ops("export-backup", "offsite", out).status, 0);
    assert.deepEqual(readdirSync(out), ["offsite.bundle.json"]);
    const bundle = join(out, "offsite.bundle.json");
    assert.equal(readFileSync(bundle, "utf8"), '{"partial":false}');
    assert.equal(statSync(bundle).mode & 0o077, 0);
    assert.equal(statSync(out).mode & 0o077, 0);
    assert.notEqual(h.ops("export-backup", "offsite", out).status, 0);
    assert.equal(readFileSync(bundle, "utf8"), '{"partial":false}');
    assert.equal(h.ops("export-ledger", out).status, 0);
    assert.ok(
      readdirSync(out).some((name) =>
        /^deletions-\d{8}T\d{6}Z\.json$/.test(name),
      ),
    );
  } finally {
    h.cleanup();
  }
});
test("export waits for no other operation: it shares the lock with delete, prune and restore", () => {
  const h = harness();
  try {
    h.configure("app:v1");
    mkdirSync(join(h.state, "ops-state", "update.lock"), { recursive: true });
    const out = join(h.state, "external");
    for (const args of [
      ["export-backup", "offsite", out],
      ["export-ledger", out],
      ["delete", "0b1f6a5e-6f2d-4c4b-9a43-2b8f5b9d6c11"],
    ]) {
      const result = h.ops(...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Outra operação está em andamento/);
    }
    assert.ok(!existsSync(out));
  } finally {
    h.cleanup();
  }
});
test("import sends the whole bundle through stdin; ledger import is explicit", () => {
  const h = harness();
  try {
    h.configure("app:v1");
    const source = join(h.state, "external");
    mkdirSync(source);
    writeFileSync(join(source, "offsite.bundle.json"), "BUNDLE");
    writeFileSync(join(source, "deletions.json"), "LEDGER");
    assert.equal(h.ops("import-backup", "offsite", source).status, 0);
    assert.equal(
      h.ops("import-ledger", join(source, "deletions.json")).status,
      0,
    );
    const received = readdirSync(h.state)
      .filter((name) => name.startsWith("stdin-"))
      .sort()
      .map((name) => readFileSync(join(h.state, name), "utf8"));
    assert.deepEqual(received, ["BUNDLE", "LEDGER"]);
    assert.match(h.ops("status").log(), /storage\.mjs import offsite/);
    assert.match(h.ops("status").log(), /storage\.mjs ledger-merge/);
    assert.notEqual(h.ops("import-backup", "missing", source).status, 0);
  } finally {
    h.cleanup();
  }
});
const publish = (h, extra = {}) =>
  h.run("ops/ghcr-publish.sh", [], {
    COMMIT_SHA: "abc123",
    OWNER: "PetersonFonsec",
    REPOSITORY: "PetersonFonsec/White-Oven",
    GH_TOKEN: "synthetic-token",
    STUB_REVISION: "abc123",
    ...extra,
  });
const pushed = (log) => /docker push ghcr\.io\/petersonfonsec\//.test(log);
test("GHCR: first publication of a package that does not exist yet", () => {
  const h = harness();
  try {
    h.mark(
      "manifest-error",
      "denied: requested access to the resource is denied",
    );
    h.mark("api-status", "404");
    const result = publish(h);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(pushed(result.log()));
    assert.match(result.log(), /users\/petersonfonsec\/packages\/container/);
  } finally {
    h.cleanup();
  }
});
test("GHCR: existing tag is preserved, never pushed again", () => {
  const h = harness();
  try {
    h.mark("manifest-exists", "");
    const result = publish(h);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /digest existente preservado/);
    assert.ok(!pushed(result.log()));
  } finally {
    h.cleanup();
  }
});
test("GHCR: existing package without this tag is published", () => {
  const h = harness();
  try {
    h.mark("manifest-error", "manifest unknown");
    const result = publish(h);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(pushed(result.log()));
  } finally {
    h.cleanup();
  }
});
test("GHCR: authorization error on an existing package fails closed", () => {
  const h = harness();
  try {
    h.mark("manifest-error", "unauthorized: authentication required");
    h.mark("api-status", "200");
    const result = publish(h);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /erro de autorização/);
    assert.ok(!pushed(result.log()));
  } finally {
    h.cleanup();
  }
});
test("GHCR: GitHub API refusing the check fails closed", () => {
  const h = harness();
  try {
    h.mark("manifest-error", "denied");
    h.mark("api-status", "403");
    const result = publish(h);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HTTP 403/);
    assert.ok(!pushed(result.log()));
  } finally {
    h.cleanup();
  }
});
test("GHCR: network failures fail closed and never push", () => {
  const h = harness();
  try {
    h.mark(
      "manifest-error",
      "Get https://ghcr.io/v2/: dial tcp: lookup ghcr.io: no such host",
    );
    const registryDown = publish(h);
    assert.equal(registryDown.status, 1);
    assert.match(registryDown.stderr, /Registry inacessível/);
    // A generic "not found" page is not proof that the tag is absent.
    writeFileSync(join(h.state, "manifest-error"), "404 page not found\n");
    assert.equal(publish(h).status, 1);
    writeFileSync(join(h.state, "manifest-error"), "denied\n");
    const apiDown = publish(h);
    assert.equal(apiDown.status, 1);
    assert.match(apiDown.stderr, /HTTP 000/);
    h.mark("gh-fails", "");
    assert.equal(publish(h).status, 1);
    assert.ok(!pushed(h.ops("status").log()));
  } finally {
    h.cleanup();
  }
});
test("GHCR: interrupted or unconfirmed push fails; wrong revision is refused", () => {
  const h = harness();
  try {
    h.mark("manifest-error", "manifest unknown");
    h.mark("push-fails", "");
    assert.equal(publish(h).status, 1);
    rmSync(join(h.state, "push-fails"));
    h.mark("push-unconfirmed", "");
    assert.match(publish(h).stderr, /não confirmou a tag/);
    const wrong = publish(h, { STUB_REVISION: "other" });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /não corresponde ao commit/);
  } finally {
    h.cleanup();
  }
});
const T1 = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const LINEAGE = "33333333-3333-4333-8333-333333333333";
const HASH = "ab".repeat(32);
const ledgerText = ({ head = 1, rows } = {}) =>
  `# whiteoven-customer-erasures-2 lineage=${LINEAGE} head=${head} head_hash=${HASH} exported_at=20261031T120000Z\n` +
  "seq,tenant_id,customer_id,deleted_at,hash\n" +
  (rows ?? `1,${T1},${C1},2026-10-31T12:00:00.500000Z,${HASH}\n`);

function apiHarness() {
  const h = harness();
  const api = (...args) => h.run("ops/api-backup.sh", args);
  const noDocker = () =>
    !existsSync(join(h.state, "log")) ||
    !readFileSync(join(h.state, "log"), "utf8").includes("docker");
  const ledger = (text) => {
    const path = join(h.state, `ledger-${Math.random()}.csv`);
    writeFileSync(path, text);
    return path;
  };
  const lockReleased = () =>
    !existsSync(join(h.state, "ops-state", "api-backup.lock"));
  return { ...h, api, noDocker, ledger, lockReleased };
}

test("API restore refuses before touching Docker without confirmation or with a bad ID", () => {
  const h = apiHarness();
  try {
    const unconfirmed = h.api("restore", "copia-1");
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stderr, /--confirm-offline/);
    assert.equal(h.api("backup", "../fora").status, 1);
    assert.equal(h.api("restore", "copia;rm", "--confirm-offline").status, 1);
    assert.equal(
      h.api(
        "restore",
        "copia-1",
        "--confirm-offline",
        "--erasures",
        join(h.state, "ausente.csv"),
      ).status,
      1,
    );
    // The cut-off confirmation is a ledger export time and only goes with a ledger.
    const ledger = h.ledger(ledgerText());
    for (const args of [
      ["--accept-erasures-until", "20261031T120000Z"],
      ["--erasures", ledger, "--accept-erasures-until", "ontem"],
      ["--erasures", ledger, "--accept-erasures-until", "2026-10-31"],
      [
        "--erasures",
        ledger,
        "--accept-erasures-until",
        "20261031T120000Z",
        "--accept-erasures-until",
        "20261031T120000Z",
      ],
    ]) {
      const refused = h.api("restore", "copia-1", "--confirm-offline", ...args);
      assert.equal(refused.status, 1, args.join(" "));
    }
    assert.ok(h.noDocker(), "nothing reached Docker");
    assert.ok(h.lockReleased(), "the lock is released on refusal");
  } finally {
    h.cleanup();
  }
});

test("API restore refuses a ledger that is not a complete, well-formed export", () => {
  const h = apiHarness();
  try {
    const cases = [
      [
        ledgerText().replace("whiteoven-customer-erasures-2", "outro"),
        /cabeçalho/,
      ],
      [ledgerText().replace("seq,tenant_id", "id,tenant_id"), /colunas/],
      [
        ledgerText({
          rows: `1,${T1},${C1},2026-10-31T12:00:00.500000Z,${HASH}\n\\.\n`,
        }),
        /fora do formato/,
      ],
      [
        ledgerText({ rows: `1,${T1},${C1},2026-10-31 12:00:00+00,${HASH}\n` }),
        /fora do formato/,
      ],
      [ledgerText({ head: 2 }), /incompleto/],
      [
        ledgerText().replace(
          "exported_at=20261031T120000Z",
          "exported_at=ontem",
        ),
        /cabeçalho/,
      ],
      [
        ledgerText({
          rows: `1,${T1},${C1},2026-10-31T12:00:00.500000Z,${"cd".repeat(32)}\n`,
        }),
        /não confere com o cabeçalho/,
      ],
      // The old format (no lineage, no chain) proves nothing about completeness.
      [
        `tenant_id,customer_id,deleted_at\n${T1},${C1},2026-10-31 12:00:00+00\n`,
        /cabeçalho/,
      ],
    ];
    for (const [text, message] of cases) {
      const refused = h.api(
        "restore",
        "copia-1",
        "--confirm-offline",
        "--erasures",
        h.ledger(text),
      );
      assert.equal(refused.status, 1, String(message));
      assert.match(refused.stderr, message);
    }
    assert.ok(h.noDocker(), "nothing reached Docker");
    assert.ok(h.lockReleased());
  } finally {
    h.cleanup();
  }
});

test("API restore waits for an incomplete operation and a dead process's lock is taken over", () => {
  const h = apiHarness();
  try {
    const op = join(
      h.state,
      "ops-state",
      "api-restores",
      "20261031120000_abcdef",
    );
    mkdirSync(op, { recursive: true });
    writeFileSync(join(op, "state"), "backup=copia-1\nphase=DB_SWAPPED\n");
    const status = h.api("restore-status");
    assert.equal(status.status, 0);
    assert.match(
      status.stdout,
      /20261031120000_abcdef fase=DB_SWAPPED .*PENDENTE/,
    );
    const blocked = h.api(
      "restore",
      "copia-1",
      "--confirm-offline",
      "--erasures",
      h.ledger(ledgerText()),
    );
    assert.equal(blocked.status, 1);
    assert.match(
      blocked.stderr,
      /restauração incompleta: 20261031120000_abcdef/,
    );
    assert.equal(h.api("restore-rollback", "../x").status, 1);
    assert.equal(
      h.api("restore-cleanup", "20261031120000_abcdef").status,
      1,
      "only a COMPLETE operation is cleaned",
    );
    assert.ok(h.noDocker(), "nothing reached Docker");

    const lock = join(h.state, "ops-state", "api-backup.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "999999\n");
    const taken = h.api("restore-status");
    assert.equal(taken.status, 0);
    writeFileSync(join(op, "state"), "backup=copia-1\nphase=ROLLED_BACK\n");
    const again = h.api(
      "restore",
      "copia-1",
      "--confirm-offline",
      "--erasures",
      h.ledger(ledgerText({ head: 3 })),
    );
    assert.match(again.stderr, /Lock deixado pelo processo 999999/);
    assert.match(again.stderr, /incompleto/);
    assert.ok(h.lockReleased());
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    const busy = h.api("restore", "copia-1", "--confirm-offline");
    assert.match(busy.stderr, /Outra operação/);
    rmSync(lock, { recursive: true });
  } finally {
    h.cleanup();
  }
});
