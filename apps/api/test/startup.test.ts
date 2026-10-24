import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";

// Compiled layout: dist/tests/test/startup.test.js -> dist/tests/src/main.js
const MAIN = join(__dirname, "..", "src", "main.js");

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        resolve(typeof address === "object" && address ? address.port : 0),
      );
    });
  });

function run(env: NodeJS.ProcessEnv, untilOutput?: RegExp) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (untilOutput?.test(stdout)) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("process startup", () => {
  it("refuses to start with invalid configuration and exits 1 before listening", async () => {
    const result = await run({
      NODE_ENV: "test",
      API_PORT: "not-a-port",
      API_LOG_LEVEL: "x",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid API configuration/);
    assert.match(result.stderr, /API_PORT must be an integer/);
    assert.match(result.stderr, /API_LOG_LEVEL must be one of/);
    assert.doesNotMatch(result.stderr, /not-a-port|\n\s+at /);
    assert.doesNotMatch(result.stdout, /api listening/);
  });

  it("starts with valid configuration, logs JSON and stops on SIGTERM", async () => {
    const port = await freePort();
    const result = await run(
      { NODE_ENV: "test", API_PORT: String(port) },
      /api listening/,
    );
    assert.equal(result.stderr, "");
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const listening = lines.find((line) => line.msg === "api listening");
    assert.equal(listening.port, port);
    // Nest closes the app on SIGTERM, then re-raises the signal so the exit reason is preserved.
    assert.equal(result.signal, "SIGTERM");
  });
});
