// Exercises the operational scripts' decisions against a recording docker/gh/curl double,
// so failure paths that need a broken registry or host are covered without Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
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
