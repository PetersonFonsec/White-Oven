import { test, expect } from "@playwright/test";
import { createCaptureServer } from "../../src/server/http-server";
import { getRequestClient } from "../../src/server/request-context";
import { createLeadHandler } from "../../src/server/lead-handler";
import { getCaptureConfig } from "../../src/server/config";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
// Real sockets, isolated ephemeral server; no production credentials or data.
// Run once so the test does not double its synthetic load across viewport projects.
// eslint-disable-next-line no-empty-pattern -- Socket-only Playwright test deliberately uses no browser fixtures.
test("trusted socket boundary isolates abusive clients, ignores spoofing and applies read deadline", async ({}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "HTTP boundary is independent of viewport",
  );
  const config = () =>
    getCaptureConfig({
      LEADS_ENABLED: "true",
      SITE_ORIGIN: "http://localhost:4321",
      LEADS_CONTROLLER_NAME: "Test Owner",
      LEADS_PRIVACY_EMAIL: "privacy@example.test",
    });
  const handler = createLeadHandler(
    config,
    () => {
      throw new Error("invalid bodies must not reach storage");
    },
    undefined,
    Date.now,
    50,
  );
  const clients: string[] = [];
  const server = createCaptureServer(
    (req, res) => {
      const client = getRequestClient()!;
      clients.push(client);
      const body =
        req.method === "POST"
          ? (Readable.toWeb(req) as ReadableStream<Uint8Array>)
          : undefined;
      const request = new Request("http://localhost:4321/api/leads", {
        method: req.method,
        headers: {
          origin: "http://localhost:4321",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body,
        duplex: "half",
      } as RequestInit);
      void handler(request, client).then(async (response) => {
        res.writeHead(response.status);
        res.end(await response.text());
      });
    },
    new Set(["127.0.0.1"]),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { "X-Forwarded-For": "192.0.2.1" },
            body: "{}",
          })
        ).status,
      ).toBe(422);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": "192.0.2.1" },
          body: "{}",
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": "192.0.2.2" },
          body: "{}",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await fetch(url, {
          headers: { "X-Forwarded-For": "192.0.2.3, 192.0.2.4" },
        })
      ).status,
    ).toBe(403);
    const { request: httpRequest } = await import("node:http");
    // A genuine unfinished HTTP request must get a bounded response or closed socket.
    const status = await new Promise<number | string>((resolve, reject) => {
      const req = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            "X-Forwarded-For": "192.0.2.5",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", (error: NodeJS.ErrnoException) =>
        error.code === "ECONNRESET" ? resolve("closed") : reject(error),
      );
      req.write("{");
      req.setTimeout(1500, () => {
        req.destroy();
        reject(new Error("body deadline failed"));
      });
    });
    expect([408, "closed"]).toContain(status);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { "X-Forwarded-For": "192.0.2.6" },
          body: "{}",
        })
      ).status,
    ).toBe(422);
    expect(clients).toContain("192.0.2.2");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const direct = createCaptureServer((_req, res) => {
    res.end(getRequestClient());
  });
  await new Promise<void>((resolve) => direct.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${(direct.address() as AddressInfo).port}`,
      { headers: { "X-Forwarded-For": "198.51.100.1" } },
    );
    expect(await response.text()).toBe("127.0.0.1");
  } finally {
    direct.closeAllConnections();
    await new Promise<void>((resolve) => direct.close(() => resolve()));
  }
});
