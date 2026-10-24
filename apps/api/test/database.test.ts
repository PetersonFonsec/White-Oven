import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { MIGRATIONS } from "../src/database/migrations";
import {
  applyPasswordChanges,
  runMigrations,
  scramVerifier,
} from "../src/database/migrate";
import {
  UnsafeDatabaseRoleError,
  assertSafeRuntimeRole,
} from "../src/database/runtime-role";
import { json, startTestServer } from "./helpers";
import {
  APP_PASSWORD,
  PLATFORM_PASSWORD,
  canLogin,
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";

const RUNTIME_ROLES = ["whiteoven_app", "whiteoven_platform"] as const;

/** Runs `sql` and returns the PostgreSQL SQLSTATE it failed with (or undefined on success). */
async function sqlState(
  orm: MikroORM,
  sql: string,
): Promise<string | undefined> {
  try {
    await orm.em.getConnection().execute(sql);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const INSUFFICIENT_PRIVILEGE = "42501";

describe("PostgreSQL roles and migrations", databaseSuite, () => {
  let database: TestDatabase;
  let owner: MikroORM;
  let app: MikroORM;
  let platform: MikroORM;

  before(async () => {
    database = await createTestDatabase();
    owner = await database.connect(database.ownerUrl);
    app = await database.connect(database.appUrl);
    platform = await database.connect(database.platformUrl);
  });
  after(() => database?.drop());

  it("applies every migration and leaves nothing pending", async () => {
    const check = await runMigrations(
      { ownerUrl: database.ownerUrl, passwords: {} },
      "check",
    );
    assert.deepEqual(check.pending, []);
    const again = await runMigrations({
      ownerUrl: database.ownerUrl,
      passwords: {},
    });
    assert.deepEqual(again.applied, []);
  });

  it("migrates a fresh database when the cluster-wide roles already exist", async () => {
    const fresh = await createTestDatabase({ migrate: false });
    try {
      const pending = await runMigrations(
        { ownerUrl: fresh.ownerUrl, passwords: {} },
        "check",
      );
      assert.deepEqual(
        pending.pending,
        MIGRATIONS.map((m) => m.name),
      );
      const run = await runMigrations({
        ownerUrl: fresh.ownerUrl,
        passwords: {},
      });
      assert.deepEqual(
        run.applied,
        MIGRATIONS.map((m) => m.name),
      );
    } finally {
      await fresh.drop();
    }
  });

  it("creates runtime roles without BYPASSRLS, superuser, DDL or owner membership", async () => {
    const rows = await owner.em
      .getConnection()
      .execute<Record<string, unknown>[]>(
        `select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication,
              rolinherit, rolcanlogin,
              pg_has_role(oid, 'whiteoven_owner', 'MEMBER') as member_of_owner
         from pg_roles where rolname = any(?::text[]) order by rolname`,
        [`{${RUNTIME_ROLES.join(",")}}`],
      );
    assert.deepEqual(
      rows,
      RUNTIME_ROLES.map((rolname) => ({
        rolname,
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolinherit: false,
        rolcanlogin: true,
        member_of_owner: false,
      })),
    );
  });

  it("keeps the owner role without SUPERUSER or BYPASSRLS", async () => {
    const [row] = await owner.em
      .getConnection()
      .execute<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
        "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
      );
    assert.deepEqual(row, { rolsuper: false, rolbypassrls: false });
  });

  for (const role of RUNTIME_ROLES) {
    it(`${role} cannot run DDL`, async () => {
      const orm = role === "whiteoven_app" ? app : platform;
      for (const statement of [
        "create table ddl_probe (id int)",
        "create schema ddl_probe",
        "create temporary table ddl_probe (id int)",
        "create function ddl_probe() returns int language sql as 'select 1'",
        "alter table mikro_orm_migrations add column ddl_probe int",
        "drop table mikro_orm_migrations",
      ]) {
        assert.equal(
          await sqlState(orm, statement),
          INSUFFICIENT_PRIVILEGE,
          statement,
        );
      }
    });

    it(`${role} cannot read or rewrite the migration history`, async () => {
      const orm = role === "whiteoven_app" ? app : platform;
      assert.equal(
        await sqlState(orm, "select * from mikro_orm_migrations"),
        INSUFFICIENT_PRIVILEGE,
      );
      assert.equal(
        await sqlState(orm, "delete from mikro_orm_migrations"),
        INSUFFICIENT_PRIVILEGE,
      );
    });
  }

  it("whiteoven_app passes the API startup role check", async () => {
    await assertSafeRuntimeRole(app);
  });

  it("rejects whiteoven_platform in the API startup role check, although it has no elevated attributes", async () => {
    await assert.rejects(assertSafeRuntimeRole(platform), (error) => {
      assert.ok(error instanceof UnsafeDatabaseRoleError);
      assert.deepEqual(error.reasons, ["not_app_role"]);
      return true;
    });
  });

  it("whiteoven_app cannot switch its effective user with SET ROLE", async () => {
    // The startup check compares session_user and current_user; today whiteoven_app is a member
    // of no role, so the effective user cannot drift.
    assert.equal(
      await sqlState(app, "set role whiteoven_platform"),
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it("applies runtime password changes atomically: a failing second change keeps the first", async () => {
    const replacement = "replacement-app-password-0001";
    await assert.rejects(
      applyPasswordChanges(owner, [
        { role: "whiteoven_app", verifier: scramVerifier(replacement) },
        // Fails inside the transaction, after whiteoven_app was altered.
        {
          role: "whiteoven_missing_role_for_test",
          verifier: scramVerifier(replacement),
        },
      ]),
      (error) => (error as { code?: string }).code === "42704",
    );
    const withReplacement = new URL(database.appUrl);
    withReplacement.password = replacement;
    assert.equal(await canLogin(withReplacement.toString()), false);
    assert.equal(await canLogin(database.appUrl), true);
  });

  it("applies every runtime password change when all of them succeed", async () => {
    // Same passwords the other test processes use: roles are cluster-wide.
    await applyPasswordChanges(owner, [
      { role: "whiteoven_app", verifier: scramVerifier(APP_PASSWORD) },
      {
        role: "whiteoven_platform",
        verifier: scramVerifier(PLATFORM_PASSWORD),
      },
    ]);
    assert.equal(await canLogin(database.appUrl), true);
    assert.equal(await canLogin(database.platformUrl), true);
  });

  it("grants DML on new owner tables to whiteoven_app only", async () => {
    await owner.em
      .getConnection()
      .execute(
        "create table default_privileges_probe (id int generated always as identity primary key, label text)",
      );
    try {
      const sql = app.em.getConnection();
      await sql.execute(
        "insert into default_privileges_probe (label) values ('a')",
      );
      await sql.execute("update default_privileges_probe set label = 'b'");
      const rows = await sql.execute(
        "select label from default_privileges_probe",
      );
      assert.deepEqual(rows, [{ label: "b" }]);
      await sql.execute("delete from default_privileges_probe");
      assert.equal(
        await sqlState(app, "truncate default_privileges_probe"),
        INSUFFICIENT_PRIVILEGE,
      );
      assert.equal(
        await sqlState(platform, "select * from default_privileges_probe"),
        INSUFFICIENT_PRIVILEGE,
      );
    } finally {
      await owner.em
        .getConnection()
        .execute("drop table default_privileges_probe");
    }
  });

  it("revokes CONNECT from PUBLIC and EXECUTE on new functions from PUBLIC", async () => {
    const [database_acl] = await owner.em
      .getConnection()
      .execute<{ public_connect: boolean }[]>(
        `select exists (select 1 from pg_database d, aclexplode(d.datacl) a
                       where d.datname = current_database() and a.grantee = 0) as public_connect`,
      );
    assert.deepEqual(database_acl, { public_connect: false });

    const sql = owner.em.getConnection();
    await sql.execute(
      "create function execute_probe() returns int language sql as 'select 1'",
    );
    try {
      assert.equal(
        await sqlState(app, "select execute_probe()"),
        INSUFFICIENT_PRIVILEGE,
      );
    } finally {
      await sql.execute("drop function execute_probe()");
    }
  });

  it("rejects the owner in the API startup role check", async () => {
    await assert.rejects(assertSafeRuntimeRole(owner), (error) => {
      assert.ok(error instanceof UnsafeDatabaseRoleError);
      assert.deepEqual(error.reasons, [
        "not_app_role",
        "create_role",
        "create_db",
        "owns_database",
        "owns_relations",
        // pg_has_role counts a role as a member of itself.
        "member_of_owner",
        "create_in_public",
        "create_in_database",
      ]);
      return true;
    });
  });

  it("serves /health/ready once the database answers", async () => {
    const server = await startTestServer({ DATABASE_URL: database.appUrl });
    try {
      const response = await fetch(`${server.baseUrl}/health/ready`);
      assert.equal(response.status, 200);
      assert.deepEqual(await json(response), { status: "ok" });
    } finally {
      await server.close();
    }
  });

  it("refuses to roll back the role migration", async () => {
    const orm = await database.connect(database.ownerUrl);
    const instance = new MIGRATIONS[0]!.class(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      orm.driver as any,
      orm.config,
    );
    assert.throws(() => instance.down(), /forward-only/);
  });
});
