import assert from "node:assert/strict";
import test from "node:test";
import {
  createCustomerClient,
  type SecretStore,
} from "../src/customer/client.ts";
import { secureRecord, type SecureKV } from "../src/customer/secure-record.ts";
import { randomUUID } from "node:crypto";

function secret(
  value: string | null = "old-refresh",
): SecretStore & { value: string | null } {
  return {
    value,
    async read() {
      return this.value;
    },
    async write(next) {
      this.value = next;
    },
    async remove() {
      this.value = null;
    },
  };
}
test("parallel requests share a refresh and persist only the rotating refresh token", async () => {
  const saved = secret();
  let rotations = 0;
  const calls: { url: string; headers: Headers }[] = [];
  const client = createCustomerClient({
    apiUrl: "https://api.test",
    storeSlug: "loja-a",
    secret: saved,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      if (String(url).endsWith("auth/refresh")) {
        rotations++;
        assert.equal(saved.value, null, "old token is consumed before request");
        assert.equal(
          JSON.parse(init!.body as string).refreshToken,
          "old-refresh",
        );
        return Response.json({
          accessToken: "secret-access",
          refreshToken: "new-refresh",
          expiresIn: 900,
        });
      }
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer secret-access",
      );
      return Response.json({ ok: true });
    },
  });
  await Promise.all([client.request("me"), client.request("me/addresses")]);
  assert.equal(rotations, 1);
  assert.equal(saved.value, "new-refresh");
  assert.ok(
    calls.every((call) =>
      call.url.startsWith("https://api.test/v1/customer/stores/loja-a/"),
    ),
  );
});

test("lost refresh response is never replayed; logout failure retains a token for revocation retry", async () => {
  const saved = secret();
  let calls = 0;
  const client = createCustomerClient({
    apiUrl: "https://api.test",
    storeSlug: "loja-a",
    secret: saved,
    fetch: async () => {
      calls++;
      throw new Error("offline");
    },
  });
  await assert.rejects(client.restore());
  await assert.rejects(client.request("me"));
  assert.equal(calls, 1);
  assert.equal(saved.value, null);
  await saved.write("revoke-me");
  await assert.rejects(client.logout());
  assert.equal(saved.value, "revoke-me");
});

test("chunked secure records preserve Unicode, isolate scopes, and keep the old commit on failed writes", async () => {
  const values = new Map<string, string>();
  let failHead = false;
  const kv: SecureKV = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      if (failHead && key.endsWith("head")) throw new Error("disk full");
      assert.ok(Buffer.byteLength(value) <= 2048);
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
  const a = secureRecord(kv, "store-a", randomUUID),
    b = secureRecord(kv, "store-b", randomUUID);
  const text = JSON.stringify({ message: "🍕São Paulo ".repeat(1000) });
  await a.write(text);
  assert.equal(await a.read(), text);
  assert.equal(await b.read(), null);
  failHead = true;
  await assert.rejects(a.write("replacement"));
  assert.equal(await a.read(), text);
  failHead = false;
  await a.write("new");
  assert.equal(await a.read(), "new");
  const head = JSON.parse(values.get("store-a.head")!);
  values.delete(`store-a.${head.id}.0`);
  await assert.rejects(a.read(), /incompletos/);
});

test("a failed sign-in ends the previous session instead of silently refreshing back into it", async () => {
  for (const failure of ["invalid", "network", "storage"] as const) {
    const saved = secret("old-refresh");
    const paths: string[] = [];
    const client = createCustomerClient({
      apiUrl: "https://api.test",
      storeSlug: "loja-a",
      secret: saved,
      fetch: async (url, init) => {
        const path = String(url).split("/loja-a/")[1]!;
        paths.push(path);
        if (path === "auth/logout") {
          assert.equal(
            JSON.parse(init!.body as string).refreshToken,
            "old-refresh",
          );
          return new Response(null, { status: 204 });
        }
        if (path === "auth/refresh")
          return Response.json({
            accessToken: "old-access",
            refreshToken: "old-rotated",
            expiresIn: 900,
          });
        if (path === "auth/login") {
          if (failure === "network") throw new Error("offline");
          return Response.json(
            { code: "INVALID_CREDENTIALS" },
            { status: 401 },
          );
        }
        return Response.json({ ok: true });
      },
    });
    await client.request("me");
    assert.equal(saved.value, "old-rotated");
    if (failure === "storage")
      saved.remove = async () => {
        throw new Error("keychain unavailable");
      };
    paths.length = 0;
    await assert.rejects(
      client.signIn("login", { email: "x@example.invalid", password: "x" }),
      (error: { code?: string }) =>
        error.code ===
        {
          invalid: "INVALID_CREDENTIALS",
          network: "NETWORK",
          storage: "STORAGE",
        }[failure],
    );
    assert.equal(client.signedIn, false);
    await assert.rejects(client.request("me"), { code: "LOGIN_REQUIRED" });
    await client.restore();
    assert.equal(client.signedIn, false);
    assert.ok(
      !paths.includes("auth/refresh"),
      `${failure}: old token never refreshed`,
    );
    if (failure === "storage") {
      assert.deepEqual(
        paths,
        [],
        "nothing is sent when the old session cannot be removed",
      );
    } else {
      assert.equal(saved.value, null);
      assert.deepEqual(paths, ["auth/logout", "auth/login"]);
    }
  }
});

test("a sign-in waits for an in-flight rotation so the previous identity is not persisted afterwards", async () => {
  const saved = secret("old-refresh");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const client = createCustomerClient({
    apiUrl: "https://api.test",
    storeSlug: "loja-a",
    secret: saved,
    fetch: async (url) => {
      const path = String(url);
      if (path.endsWith("auth/refresh")) {
        await gate;
        return Response.json({
          accessToken: "old-access",
          refreshToken: "old-rotated",
          expiresIn: 900,
        });
      }
      if (path.endsWith("auth/logout"))
        return new Response(null, { status: 204 });
      if (path.endsWith("auth/login"))
        return Response.json({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresIn: 900,
        });
      return Response.json({ ok: true });
    },
  });
  const earlier = client.request("me");
  await new Promise((resolve) => setImmediate(resolve));
  const signingIn = client.signIn("login", {});
  release();
  await earlier;
  await signingIn;
  assert.equal(saved.value, "new-refresh");
  assert.equal(client.signedIn, true);
});

function faultyKV() {
  const values = new Map<string, string>();
  const faults = {
    set: ((): boolean => false) as (key: string, value: string) => boolean,
    remove: ((): boolean => false) as (key: string) => boolean,
    /** Set lands, then throws (a native error reported after the write). */
    lateSet: ((): boolean => false) as (key: string) => boolean,
  };
  const kv: SecureKV = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      assert.ok(Buffer.byteLength(value) <= 2048);
      if (faults.set(key, value)) throw new Error(`set failed: ${key}`);
      values.set(key, value);
      if (faults.lateSet(key)) throw new Error(`late failure: ${key}`);
    },
    async remove(key) {
      if (faults.remove(key)) throw new Error(`remove failed: ${key}`);
      values.delete(key);
    },
  };
  /** Only the chunks the head references remain: nothing orphaned, no journal left. */
  const clean = (prefix: string) => {
    const head = values.get(`${prefix}.head`);
    const expected = new Set<string>();
    if (head) {
      const { id, count } = JSON.parse(head);
      expected.add(`${prefix}.head`);
      for (let i = 0; i < count; i++) expected.add(`${prefix}.${id}.${i}`);
    }
    assert.deepEqual(new Set(values.keys()), expected);
  };
  return { kv, values, faults, clean };
}
const previousText = JSON.stringify({
  cart: "Pizza 🍕 Calabresa — São João ".repeat(30),
});
const nextText = JSON.stringify({ cart: "Margherita ✓ 半分 ".repeat(60) });
const chunkKey = (key: string, index: number) =>
  /\.[a-f0-9-]{36}\.\d+$/.test(key) && key.endsWith(`.${index}`);

test("secure record: failed writes before the commit keep the previous version and leave no orphans", async () => {
  const cases: [string, (h: ReturnType<typeof faultyKV>) => void][] = [
    ["first chunk", (h) => (h.faults.set = (key) => chunkKey(key, 0))],
    ["middle chunk", (h) => (h.faults.set = (key) => chunkKey(key, 2))],
    ["pointer", (h) => (h.faults.set = (key) => key.endsWith(".head"))],
  ];
  for (const [name, fail] of cases) {
    const h = faultyKV();
    const record = secureRecord(h.kv, "s", randomUUID);
    await record.write(previousText);
    h.clean("s");
    fail(h);
    await assert.rejects(record.write(nextText), /set failed/, name);
    assert.equal(await record.read(), previousText, `${name}: previous kept`);
    h.clean("s");
    h.faults.set = () => false;
    await record.write(nextText);
    assert.equal(await record.read(), nextText);
    h.clean("s");
  }
});

test("secure record: a failed compensation never masks the original error and is swept later", async () => {
  const h = faultyKV();
  const record = secureRecord(h.kv, "s", randomUUID);
  await record.write(previousText);
  h.faults.set = (key) => chunkKey(key, 3);
  h.faults.remove = () => true;
  await assert.rejects(record.write(nextText), /set failed/);
  assert.equal(await record.read(), previousText);
  assert.ok(h.values.has("s.journal"), "orphans stay named by the journal");
  h.faults.set = () => false;
  h.faults.remove = () => false;
  await record.write(nextText);
  assert.equal(await record.read(), nextText);
  h.clean("s");
});

test("secure record: a committed write succeeds even when cleanup fails, and never loses the head", async () => {
  const h = faultyKV();
  const record = secureRecord(h.kv, "s", randomUUID);
  await record.write(previousText);
  // Cleanup of the replaced version fails: the write is still reported as done.
  h.faults.remove = (key) => /\.[a-f0-9-]{36}\.\d+$/.test(key);
  await record.write(nextText);
  assert.equal(await record.read(), nextText);
  h.faults.remove = () => false;
  // The pointer lands but its write reports an error: the new chunks are not removed.
  h.faults.lateSet = (key) => key.endsWith(".head");
  await record.write(previousText);
  assert.equal(await record.read(), previousText);
  h.faults.lateSet = () => false;
  await record.write(nextText);
  assert.equal(await record.read(), nextText);
  h.clean("s");
});

test("secure record: chunks of a process killed mid-write or mid-removal are swept by the next operation", async () => {
  const h = faultyKV();
  await secureRecord(h.kv, "s", randomUUID).write(previousText);
  // Killed after two chunks: every later storage call of that process fails.
  h.faults.set = (key) =>
    key.endsWith(".head") ||
    (/\.[a-f0-9-]{36}\.\d+$/.test(key) &&
      !chunkKey(key, 0) &&
      !chunkKey(key, 1));
  h.faults.remove = () => true;
  await assert.rejects(secureRecord(h.kv, "s", randomUUID).write(nextText));
  assert.ok(
    [...h.values.keys()].filter((key) => /\.\d+$/.test(key)).length > 3,
    "the killed write left chunks behind",
  );
  h.faults.set = () => false;
  h.faults.remove = () => false;
  const restarted = secureRecord(h.kv, "s", randomUUID);
  assert.equal(await restarted.read(), previousText);
  await restarted.write(nextText);
  assert.equal(await restarted.read(), nextText);
  h.clean("s");
  // Killed after the pointer was removed but before the chunks were.
  h.faults.remove = (key) => !key.endsWith(".head");
  await secureRecord(h.kv, "s", randomUUID).remove();
  h.faults.remove = () => false;
  const again = secureRecord(h.kv, "s", randomUUID);
  assert.equal(await again.read(), null);
  await again.write(previousText);
  h.clean("s");
  await again.remove();
  h.clean("s");
});

test("secure record: concurrent writes and removals run one at a time", async () => {
  const h = faultyKV();
  const record = secureRecord(h.kv, "s", randomUUID);
  await Promise.all([
    record.write(previousText),
    record.write(nextText),
    record.remove(),
    record.write("🍕 final"),
  ]);
  assert.equal(await record.read(), "🍕 final");
  h.clean("s");
});
