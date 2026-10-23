import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTrustedProxies,
  resolveRequestClient,
  createCaptureServer,
} from "../src/server/http-server.ts";
import {
  getRequestClient,
  withRequestClient,
} from "../src/server/request-context.ts";
test("client identity comes from socket unless exact trusted proxy replaces a single valid IP", () => {
  const proxies = parseTrustedProxies("127.0.0.1, ::1");
  assert.equal(
    resolveRequestClient("192.0.2.1", "198.51.100.1", proxies),
    "192.0.2.1",
  );
  assert.equal(
    resolveRequestClient("::ffff:127.0.0.1", "198.51.100.1", proxies),
    "198.51.100.1",
  );
  assert.equal(
    resolveRequestClient("127.0.0.1", "198.51.100.1, 192.0.2.2", proxies),
    null,
  );
  assert.equal(resolveRequestClient("127.0.0.1", undefined, proxies), null);
  assert.equal(resolveRequestClient("127.0.0.1", "invalid", proxies), null);
  assert.equal(resolveRequestClient(undefined, "198.51.100.1", proxies), null);
  assert.equal(
    resolveRequestClient("127.0.0.1", ["198.51.100.1"], proxies),
    null,
  );
  assert.throws(
    () => parseTrustedProxies("0.0.0.0/0"),
    /INVALID_TRUSTED_PROXIES/,
  );
});
test("request context is isolated between concurrent visitors and absent outside a request", async () => {
  assert.equal(getRequestClient(), undefined);
  const results = await Promise.all(
    ["client-a", "client-b"].map((client) =>
      withRequestClient(client, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestClient();
      }),
    ),
  );
  assert.deepEqual(results, ["client-a", "client-b"]);
  assert.equal(getRequestClient(), undefined);
});
test("launcher defines socket, headers, body and connection limits without opening a port", () => {
  const server = createCaptureServer(() => {});
  assert.equal(server.requestTimeout, 7000);
  assert.equal(server.headersTimeout, 5000);
  assert.equal(server.maxConnections, 128);
  assert.equal(server.maxHeaderSize, 8192);
  assert.equal(server.keepAliveTimeout, 5000);
  assert.equal(server.timeout, 8000);
  server.close();
});
