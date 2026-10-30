import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPO_PUSH_TOKEN,
  PushRequestError,
  deliveryOutcome,
  parseExpoTickets,
  pushBody,
  pushRetryDelaySeconds,
} from "../src/push/push-rules";
import { EXPO_PUSH_URL, ExpoPushSender } from "../src/push/push-sender";

const message = (to: string) => ({
  to,
  title: "Pizzaria",
  body: "Pedido #1 aceito e em preparo.",
  data: { type: "order-status" as const, orderId: "o-1" },
});

describe("push rules", () => {
  it("accepts only Expo push tokens", () => {
    for (const valid of [
      "ExponentPushToken[abcDEF123_-]",
      "ExpoPushToken[abc]",
    ])
      assert.ok(EXPO_PUSH_TOKEN.test(valid), valid);
    for (const invalid of [
      "",
      "ExponentPushToken[]",
      "ExponentPushToken[a b]",
      "ExponentPushToken[abc]\n",
      "fcm:abc",
      `ExponentPushToken[${"a".repeat(201)}]`,
    ])
      assert.ok(!EXPO_PUSH_TOKEN.test(invalid), invalid);
  });

  it("writes the number and the new state only, by fulfillment", () => {
    assert.equal(
      pushBody("PREPARING", "PICKUP", 7),
      "Pedido #7 aceito e em preparo.",
    );
    assert.equal(
      pushBody("READY", "PICKUP", 7),
      "Pedido #7 pronto para retirada.",
    );
    assert.equal(
      pushBody("READY", "DELIVERY", 7),
      "Pedido #7 pronto. Logo sai para entrega.",
    );
    assert.equal(
      pushBody("OUT_FOR_DELIVERY", "DELIVERY", 7),
      "Pedido #7 saiu para entrega.",
    );
    assert.equal(
      pushBody("COMPLETED", "PICKUP", 7),
      "Pedido #7 retirado. Bom apetite!",
    );
    assert.equal(
      pushBody("COMPLETED", "DELIVERY", 7),
      "Pedido #7 entregue. Bom apetite!",
    );
    assert.equal(
      pushBody("REJECTED", "DELIVERY", 7),
      "A pizzaria não pôde aceitar o pedido #7.",
    );
    assert.equal(
      pushBody("CANCELED", "PICKUP", 7),
      "O pedido #7 foi cancelado pela pizzaria.",
    );
  });

  it("backs off 30 s, 60 s, 120 s, 240 s", () => {
    assert.deepEqual(
      [1, 2, 3, 4].map(pushRetryDelaySeconds),
      [30, 60, 120, 240],
    );
  });

  it("reads Expo tickets and settles a delivery from its devices' tickets", () => {
    assert.deepEqual(
      parseExpoTickets(
        {
          data: [
            { status: "ok", id: "t1" },
            { status: "error", details: { error: "DeviceNotRegistered" } },
            { status: "error", details: { error: "MessageRateExceeded" } },
            { status: "error", details: { error: "MessageTooBig" } },
          ],
        },
        4,
      ),
      [
        { ok: true },
        { ok: false, deviceGone: true, retry: false },
        { ok: false, deviceGone: false, retry: true },
        { ok: false, deviceGone: false, retry: false },
      ],
    );
    assert.throws(() => parseExpoTickets({ data: [] }, 1), PushRequestError);
    assert.throws(() => parseExpoTickets({ errors: [] }, 1), PushRequestError);

    const ok = { ok: true } as const;
    const gone = { ok: false, deviceGone: true, retry: false } as const;
    const limited = { ok: false, deviceGone: false, retry: true } as const;
    assert.equal(deliveryOutcome([gone, ok]), "SENT");
    assert.equal(deliveryOutcome([gone, limited]), "RETRY");
    assert.equal(deliveryOutcome([gone]), "FAILED");
  });

  it("posts batches of 100 to Expo with the access token and maps failures to retries", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const sent = JSON.parse(String(init.body)) as unknown[];
      return new Response(
        JSON.stringify({ data: sent.map(() => ({ status: "ok" })) }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const sender = new ExpoPushSender("secret-token", fetchFn);
    const messages = Array.from({ length: 150 }, (_, index) =>
      message(`ExponentPushToken[${index}]`),
    );
    const tickets = await sender.send(messages);
    assert.equal(tickets.length, 150);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, EXPO_PUSH_URL);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret-token");
    const first = JSON.parse(String(calls[0]!.init.body));
    assert.equal(first.length, 100);
    assert.deepEqual(first[0], {
      ...message("ExponentPushToken[0]"),
      sound: "default",
      ttl: 1800,
    });

    const failing = new ExpoPushSender(
      null,
      (async () =>
        new Response("busy", { status: 503 })) as unknown as typeof fetch,
    );
    await assert.rejects(failing.send([message("x")]), PushRequestError);
    const offline = new ExpoPushSender(null, (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    await assert.rejects(offline.send([message("x")]), PushRequestError);
  });
});
