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
