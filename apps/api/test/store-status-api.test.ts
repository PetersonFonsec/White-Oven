import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { insertTenant } from "./staff-fixtures";
import { runInTenant } from "../src/tenancy/tenant-transaction";

// Kiritimati is UTC+14 and Pago Pago UTC−11: 25 hours apart, so their weekdays always differ.
const AHEAD = "Pacific/Kiritimati";
const BEHIND = "Pacific/Pago_Pago";

describe("M4.1 public store status", databaseSuite, () => {
  let database: TestDatabase;
  let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
  let server: TestServer;

  const sql = <T>(query: string, params: unknown[] = []) =>
    owner.em.getConnection().execute<T[]>(query, params);
  const store = async (timezone = "America/Sao_Paulo", status = "ACTIVE") => {
    const slug = `status-${randomUUID().slice(0, 8)}`;
    const id = await insertTenant(owner, slug, status);
    await sql("update tenants set timezone = ? where id = ?", [timezone, id]);
    return { id, slug };
  };
  /** The whole local day, in two shifts that touch at noon and midnight without overlapping. */
  const allDay = (weekdays: number[]) =>
    weekdays.flatMap((weekday) => [
      { weekday, opensAt: "00:00", closesAt: "12:00" },
      { weekday, opensAt: "12:00", closesAt: "00:00" },
    ]);
  const setHours = (
    tenantId: string,
    rules: unknown[],
    exceptions: unknown[] = [],
  ) =>
    runInTenant(owner, tenantId, (em) =>
      em.execute(
        `insert into store_opening_hours (tenant_id, rules, exceptions) values (?, ?::jsonb, ?::jsonb)
        on conflict (tenant_id) do update set rules = excluded.rules, exceptions = excluded.exceptions`,
        [tenantId, JSON.stringify(rules), JSON.stringify(exceptions)],
      ),
    );
  const setPause = (tenantId: string, until: string | null) =>
    runInTenant(owner, tenantId, (em) =>
      em.execute(
        `insert into store_pauses (tenant_id, paused_until) values (?, ${until ?? "null"})
        on conflict (tenant_id) do update set paused_until = excluded.paused_until`,
        [tenantId],
      ),
    );
  const localDay = async (timezone: string) => {
    const [row] = await sql<{ weekday: number; date: string }>(
      `select extract(dow from now() at time zone ?)::int as weekday,
        to_char(now() at time zone ?, 'YYYY-MM-DD') as date`,
      [timezone, timezone],
    );
    return row!;
  };
  const status = (slug: string) =>
    fetch(`${server.baseUrl}/v1/public/stores/${slug}/status`);

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    server = await startTestServer({
      DATABASE_URL: database.appUrl,
      DATABASE_POOL_MAX: "2",
    });
  });
  after(async () => {
    await server?.close();
    await owner?.close();
    await database?.drop();
  });

  it("answers without authentication, never cached, open inside the hours", async () => {
    const { id, slug } = await store();
    await setHours(id, allDay([0, 1, 2, 3, 4, 5, 6]));
    const response = await status(slug);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await json(response);
    assert.equal(
      Math.abs(Date.parse(body.checkedAt) - Date.now()) < 60_000,
      true,
    );
    assert.deepEqual(
      { ...body, checkedAt: undefined },
      {
        open: true,
        reason: "OPEN",
        pausedUntil: null,
        timezone: "America/Sao_Paulo",
        checkedAt: undefined,
      },
    );
  });

  it("is closed with no hours saved, and outside the hours", async () => {
    const empty = await store();
    assert.equal(
      (await json(await status(empty.slug))).reason,
      "OUTSIDE_HOURS",
    );
    const { id, slug } = await store();
    await setHours(id, []);
    const body = await json(await status(slug));
    assert.equal(body.open, false);
    assert.equal(body.reason, "OUTSIDE_HOURS");
  });

  it("reads the weekday and date in the store's own time zone", async () => {
    const today = await localDay(AHEAD);
    const ahead = await store(AHEAD);
    const behind = await store(BEHIND);
    await setHours(ahead.id, allDay([today.weekday]));
    await setHours(behind.id, allDay([today.weekday]));
    assert.equal((await json(await status(ahead.slug))).reason, "OPEN");
    assert.equal(
      (await json(await status(behind.slug))).reason,
      "OUTSIDE_HOURS",
    );
    // A closed exception for that local date wins over the weekly rules.
    await setHours(ahead.id, allDay([today.weekday]), [
      { date: today.date, closed: true, shifts: [] },
    ]);
    assert.equal(
      (await json(await status(ahead.slug))).reason,
      "OUTSIDE_HOURS",
    );
  });

  it("is closed while paused, reports when the pause ends, and reopens after it", async () => {
    const { id, slug } = await store();
    await setHours(id, allDay([0, 1, 2, 3, 4, 5, 6]));
    await setPause(id, "now() + interval '20 minutes'");
    const paused = await json(await status(slug));
    assert.equal(paused.open, false);
    assert.equal(paused.reason, "PAUSED");
    const minutesLeft = (Date.parse(paused.pausedUntil) - Date.now()) / 60_000;
    assert.ok(minutesLeft > 19 && minutesLeft <= 20.5, String(minutesLeft));

    await setPause(id, null);
    assert.deepEqual(
      [
        (await json(await status(slug))).reason,
        (await json(await status(slug))).pausedUntil,
      ],
      ["PAUSED", null],
    );

    await setPause(id, "now() - interval '1 minute'");
    const reopened = await json(await status(slug));
    assert.equal(reopened.reason, "OPEN");
    assert.equal(reopened.pausedUntil, null);
  });

  it("reports only the store in the URL, whatever tenant header is sent", async () => {
    const pausedStore = await store();
    const openStore = await store();
    for (const target of [pausedStore, openStore])
      await setHours(target.id, allDay([0, 1, 2, 3, 4, 5, 6]));
    await setPause(pausedStore.id, null);
    const response = await fetch(
      `${server.baseUrl}/v1/public/stores/${openStore.slug}/status?tenantId=${pausedStore.id}`,
      { headers: { "x-tenant-id": pausedStore.id } },
    );
    assert.equal((await json(response)).reason, "OPEN");
    assert.equal((await json(await status(pausedStore.slug))).reason, "PAUSED");
  });

  it("answers 404 for an unknown store and 403 for one that is not active", async () => {
    const unknown = await status("nao-existe-status");
    assert.equal(unknown.status, 404);
    assert.equal((await json(unknown)).code, "NOT_FOUND");
    for (const tenantStatus of ["ONBOARDING", "SUSPENDED", "CLOSED"]) {
      const { slug } = await store("America/Sao_Paulo", tenantStatus);
      const response = await status(slug);
      assert.equal(response.status, 403, tenantStatus);
      const body = await json(response);
      assert.equal(body.code, "TENANT_NOT_ACTIVE");
      assert.doesNotMatch(JSON.stringify(body), new RegExp(tenantStatus));
    }
  });
});
