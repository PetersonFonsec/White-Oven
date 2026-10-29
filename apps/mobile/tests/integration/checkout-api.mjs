import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTestDatabase } from "../../../api/dist/tests/test/postgres.js";
import { startTestServer } from "../../../api/dist/tests/test/helpers.js";
import { insertTenant } from "../../../api/dist/tests/test/staff-fixtures.js";
import {
  seedOrderStore,
  ALL_DAY,
} from "../../../api/dist/tests/test/order-fixtures.js";
import { runInTenant } from "../../../api/dist/tests/src/tenancy/tenant-transaction.js";
import { createCustomerClient } from "../../src/customer/client.ts";
import { createCommerceModel } from "../../src/cart/model.ts";
import { parseCheckoutSettings } from "../../src/cart/summary.ts";
import { addPizza, addProduct } from "../../src/cart/cart.ts";
import { parseMenu } from "../../src/menu/menu.ts";
import {
  builderMenu,
  startBuilder,
  evaluateBuilder,
} from "../../src/builder/builder.ts";

function memory() {
  let value = null;
  return {
    async read() {
      return value;
    },
    async write(next) {
      value = next;
    },
    async remove() {
      value = null;
    },
  };
}

test(
  "mobile account → address → builder/cart → quote → order → lost response/restart/retry against real PostgreSQL",
  { timeout: 120000 },
  async () => {
    const db = await createTestDatabase();
    let server;
    try {
      const owner = await db.connect(db.ownerUrl);
      const slug = `mobile-${randomUUID().slice(0, 8)}`;
      const tenantId = await insertTenant(owner, slug);
      const catalog = await seedOrderStore(owner, tenantId);
      server = await startTestServer({
        DATABASE_URL: db.appUrl,
        PLATFORM_DATABASE_URL: db.platformUrl,
      });
      const profile = await (
        await fetch(`${server.baseUrl}/v1/public/stores/${slug}`)
      ).json();
      const settings = parseCheckoutSettings(profile.checkout);
      assert.equal(settings.deliveryFeeCents, 700);
      assert.deepEqual(settings.acceptedPaymentMethods, [
        "CASH",
        "PIX_ON_DELIVERY",
      ]);
      const menu = parseMenu(
        await (
          await fetch(`${server.baseUrl}/v1/public/stores/${slug}/menu`)
        ).json(),
      );
      assert.ok(menu);
      const builder = builderMenu(menu);
      const evaluated = evaluateBuilder(
        builder,
        startBuilder(builder, catalog.calabresa),
      );
      assert.equal(evaluated.kind, "priced");
      // Choose Grande explicitly (the menu may sort Broto first).
      const pizza = { ...evaluated.configuration, sizeId: catalog.size };
      const secret = memory(),
        storage = memory();
      let dropNextOrderResponse = true;
      const requests = [];
      const transport = async (url, init) => {
        const response = await fetch(url, init);
        if (String(url).endsWith("/me/orders")) {
          requests.push({
            body: init.body,
            key: new Headers(init.headers).get("Idempotency-Key"),
          });
          if (dropNextOrderResponse && response.ok) {
            dropNextOrderResponse = false;
            await response.arrayBuffer();
            throw new Error("synthetic lost response after server commit");
          }
        }
        return response;
      };
      const make = () =>
        createCommerceModel({
          client: createCustomerClient({
            apiUrl: server.baseUrl,
            storeSlug: slug,
            fetch: transport,
            secret,
          }),
          storage,
          uuid: randomUUID,
        });
      let model = make();
      assert.equal(await model.init(), true);
      const password = "synthetic-mobile-password";
      assert.equal(
        await model.signIn("register", {
          name: "Cliente sintético",
          email: "mobile@example.invalid",
          password,
          phone: null,
          privacyPolicyVersion: "test-only",
        }),
        true,
        model.getSnapshot().error,
      );
      assert.equal(
        await model.saveAddress({
          label: "Casa",
          postalCode: "01310-100",
          street: "Rua de Teste",
          number: "10",
          complement: null,
          district: "Centro",
          city: "São Paulo",
          state: "SP",
          reference: null,
        }),
        true,
        model.getSnapshot().error,
      );
      const addressId = model.getSnapshot().addresses[0].id;
      assert.equal(
        await model.changeCart((lines) =>
          addProduct(
            addPizza(lines, {
              kind: "PIZZA",
              id: randomUUID(),
              name: "Calabresa",
              pizza,
            }),
            { id: randomUUID(), name: "Refrigerante", productId: catalog.soda },
          ),
        ),
        true,
      );
      const details = {
        fulfillment: "DELIVERY",
        addressId,
        paymentMethod: "PIX_ON_DELIVERY",
        changeForCents: null,
        notes: "Teste sintético",
      };
      assert.equal(
        await model.quote(details, 5000),
        true,
        model.getSnapshot().error,
      );
      assert.equal(model.getSnapshot().quote.totals.totalCents, 5500);
      assert.equal(model.getSnapshot().quote.totals.priceChanged, true);
      assert.equal(await model.confirm(), false);
      assert.ok(model.getSnapshot().pending);
      // The key lookup must win even though the store closed after accepting the order.
      await runInTenant(owner, tenantId, (em) =>
        em.execute("update store_opening_hours set rules = '[]'::jsonb"),
      );
      model = make();
      assert.equal(await model.init(), true, model.getSnapshot().error);
      assert.equal(await model.confirm(), true, model.getSnapshot().error);
      assert.deepEqual(requests[0], requests[1]);
      assert.equal(model.getSnapshot().receipt.number, 1);
      assert.equal(model.getSnapshot().cart.length, 0);
      await runInTenant(owner, tenantId, async (em) => {
        const [row] = await em.execute(
          "select count(*)::int as count from orders",
        );
        assert.equal(row.count, 1);
        await em.execute("update store_opening_hours set rules = ?::jsonb", [
          JSON.stringify(ALL_DAY),
        ]);
      });
      // Real catalog price change between quote and confirmation requires another confirmation.
      await model.changeCart(() => [
        { kind: "PIZZA", id: randomUUID(), name: "Calabresa", pizza },
      ]);
      await model.quote(details, 4700);
      await runInTenant(owner, tenantId, (em) =>
        em.execute(
          "update catalog_flavor_prices set price_cents = 4500 where flavor_id = ? and size_id = ?",
          [catalog.calabresa, catalog.size],
        ),
      );
      assert.equal(await model.confirm(), false);
      assert.equal(model.getSnapshot().pending, null);
      assert.equal(model.getSnapshot().quote, null);
      await model.quote(details, 4700);
      assert.equal(model.getSnapshot().quote.totals.totalCents, 5200);
      assert.equal(await model.confirm(), true, model.getSnapshot().error);
      assert.equal(model.getSnapshot().receipt.number, 2);
      assert.equal(
        await model.deleteAccount(password),
        true,
        model.getSnapshot().error,
      );
      assert.equal(model.getSnapshot().profile, null);
      assert.equal(await secret.read(), null);
      await runInTenant(owner, tenantId, async (em) => {
        const rows = await em.execute(
          "select customer_name, delivery_address, notes from orders",
        );
        assert.equal(rows.length, 2);
        assert.ok(
          rows.every(
            (row) =>
              row.customer_name === null &&
              row.delivery_address === null &&
              row.notes === null,
          ),
        );
      });
    } finally {
      await server?.close();
      await db.drop();
    }
  },
);
