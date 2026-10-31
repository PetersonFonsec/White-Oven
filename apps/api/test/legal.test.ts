import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { hashPassword } from "../src/auth/password";
import type { ApiConfig } from "../src/config/config";
import { PlatformService } from "../src/platform/platform.service";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { json, startTestServer, type TestServer } from "./helpers";
import {
  createTestDatabase,
  databaseSuite,
  type TestDatabase,
} from "./postgres";
import { bearer, insertTenant, TEST_LEGAL_VERSION } from "./staff-fixtures";

const PASSWORD = "cliente-legal-senha-forte";
const REQUEST_ID = "00000000-0000-4000-8000-000000000072";

describe(
  "M7.2 legal documents, acceptance and deletion page",
  databaseSuite,
  () => {
    let database: TestDatabase;
    let owner: Awaited<ReturnType<TestDatabase["connect"]>>;
    let app: Awaited<ReturnType<TestDatabase["connect"]>>;
    let server: TestServer;
    let platform: PlatformService;
    let operatorId: string;
    let sessionId: string;
    const slug = (name: string) => `${name}-${randomUUID().slice(0, 8)}`;

    /** A store with no documents: `insertTenant` publishes them, so they are removed here. */
    const bareTenant = async (name: string, status = "ACTIVE") => {
      const [row] = await owner.em
        .getConnection()
        .execute<{ id: string }[]>(
          "insert into tenants (slug, display_name, status) values (?, ?, ?) returning id",
          [name, `Pizzaria ${name}`, status],
        );
      if (status === "ACTIVE" || status === "SUSPENDED")
        await runInTenant(owner, row!.id, (em) =>
          em.execute(
            `insert into plan_subscriptions (tenant_id, plan, fee_basis_points, monthly_fee_cents, valid_from)
           select ?, code, fee_basis_points, monthly_fee_cents, now() - interval '1 day' from plans where code = 'FLEX'`,
            [row!.id],
          ),
        );
      return row!.id;
    };

    const publish = (
      tenantId: string,
      kind: string,
      version: string,
      body: string,
    ) =>
      platform.publishLegalDocument(
        tenantId,
        { kind, version, body },
        operatorId,
        sessionId,
        REQUEST_ID,
        "127.0.0.1",
      );

    const register = (store: string, overrides: Record<string, unknown> = {}) =>
      fetch(`${server.baseUrl}/v1/customer/stores/${store}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Cliente Legal",
          email: `legal-${randomUUID()}@teste.invalid`,
          password: PASSWORD,
          privacyPolicyVersion: TEST_LEGAL_VERSION,
          termsOfUseVersion: TEST_LEGAL_VERSION,
          ...overrides,
        }),
      });

    const signedUp = async (store: string) => {
      const email = `legal-${randomUUID()}@teste.invalid`;
      const response = await register(store, { email });
      assert.equal(response.status, 201, await response.clone().text());
      return { email, ...(await json(response)) } as {
        email: string;
        accessToken: string;
        refreshToken: string;
      };
    };

    const me = (store: string, token: string) =>
      fetch(`${server.baseUrl}/v1/customer/stores/${store}/me`, {
        headers: bearer(token),
      });

    const page = (store: string, path: string, init?: RequestInit) =>
      fetch(`${server.baseUrl}/lojas/${store}/${path}`, init);

    const deletionForm = (store: string, fields: Record<string, string>) =>
      page(store, "excluir-conta", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      });

    const customerStatus = async (tenantId: string, email: string) => {
      const [row] = await runInTenant(owner, tenantId, (em) =>
        em.execute<{ status: string }[]>(
          "select status from customers where email = ?",
          [email],
        ),
      );
      return row?.status ?? "ABSENT";
    };

    before(async () => {
      database = await createTestDatabase();
      owner = await database.connect(database.ownerUrl);
      app = await database.connect(database.appUrl);
      const hash = await hashPassword("correct horse battery staple 2026");
      const [operator] = await owner.em
        .getConnection()
        .execute<{ id: string }[]>(
          "insert into staff_users (email, name, password_hash, platform_role, mfa_secret, mfa_enabled_at) values (?, ?, ?, 'OPERATOR', 'v1.operator', now()) returning id",
          [`operator-${randomUUID()}@example.test`, "Operator", hash],
        );
      operatorId = operator!.id;
      const [session] = await owner.em
        .getConnection()
        .execute<{ id: string }[]>(
          "insert into staff_sessions (staff_user_id, mfa, refresh_token_hash, idle_expires_at) values (?, true, ?, now() + interval '1 hour') returning id",
          [operatorId, Buffer.alloc(32, 7)],
        );
      sessionId = session!.id;
      const config: ApiConfig = {
        nodeEnv: "test",
        host: "127.0.0.1",
        port: 3000,
        logLevel: "error",
        openApiEnabled: false,
        imageStorageDirectory: ".data/images",
        database: { url: database.appUrl, poolMax: 2 },
        auth: {
          accessTokenPrivateKey: null,
          mfaEncryptionKey: null,
          ownerInviteSecret: Buffer.alloc(32, 9),
          adminOrigins: ["https://admin.example.test"],
        },
        push: { delivery: "disabled", expoAccessToken: null },
      };
      platform = new PlatformService(app, config);
      server = await startTestServer({
        DATABASE_URL: database.appUrl,
        DATABASE_POOL_MAX: "4",
      });
    });
    after(async () => {
      await server?.close();
      await app?.close();
      await owner?.close();
      await database?.drop();
    });

    it("publishes versions through the operator function only, append-only and audited", async () => {
      const tenantId = await bareTenant(slug("publica"));
      const first = await publish(
        tenantId,
        "PRIVACY_POLICY",
        "2026-11",
        "Texto 1",
      );
      assert.equal(first.changed, true);
      assert.equal(first.revision, 1);
      // A retry with the same text changes nothing; another text under that version is refused.
      const again = await publish(
        tenantId,
        "PRIVACY_POLICY",
        "2026-11",
        "Texto 1",
      );
      assert.deepEqual(
        { id: again.id, changed: again.changed },
        { id: first.id, changed: false },
      );
      await assert.rejects(
        publish(tenantId, "PRIVACY_POLICY", "2026-11", "Outro texto"),
        { code: "LEGAL_VERSION_CONFLICT" },
      );
      const second = await publish(
        tenantId,
        "PRIVACY_POLICY",
        "2026-12",
        "Texto 2",
      );
      assert.equal(second.revision, 2);
      for (const [kind, version, body] of [
        ["COOKIES", "1", "x"],
        ["TERMS_OF_USE", "-1", "x"],
        ["TERMS_OF_USE", "1", "  \n "],
      ] as const)
        await assert.rejects(publish(tenantId, kind, version, body), {
          code: "VALIDATION_FAILED",
        });
      await assert.rejects(
        platform.publishLegalDocument(
          randomUUID(),
          { kind: "TERMS_OF_USE", version: "1", body: "x" },
          operatorId,
          sessionId,
          REQUEST_ID,
          "127.0.0.1",
        ),
        { code: "TENANT_NOT_FOUND" },
      );
      const listed = await platform.listLegalDocuments(
        tenantId,
        operatorId,
        sessionId,
      );
      assert.deepEqual(
        listed.map((row) => [row.kind, row.version, row.revision, row.body]),
        [
          ["PRIVACY_POLICY", "2026-12", 2, "Texto 2"],
          ["PRIVACY_POLICY", "2026-11", 1, "Texto 1"],
        ],
      );
      // The audit keeps a hash of the text, never the text.
      const audit = await owner.em
        .getConnection()
        .execute<{ changes: Record<string, unknown> }[]>(
          "select changes from audit_events where tenant_id = ? and action = 'legal_document.published' order by at",
          [tenantId],
        );
      assert.equal(audit.length, 2);
      assert.equal(typeof audit[0]!.changes["bodySha256"], "string");
      assert.equal(JSON.stringify(audit).includes("Texto 1"), false);
      // Neither the app role nor the owner can change a published text.
      await assert.rejects(
        runInTenant(app, tenantId, (em) =>
          em.execute(
            "insert into legal_documents (tenant_id, kind, version, revision, body, body_sha256) values (?, 'TERMS_OF_USE', 'x', 1, 'x', sha256('x'::bytea))",
            [tenantId],
          ),
        ),
        { code: "42501" },
      );
      await assert.rejects(
        runInTenant(owner, tenantId, (em) =>
          em.execute("update legal_documents set body = 'mudou'"),
        ),
        /append-only/,
      );
      await assert.rejects(
        runInTenant(owner, tenantId, (em) =>
          em.execute("delete from legal_documents"),
        ),
        /append-only/,
      );
    });

    it("serves only the store's current versions, in every status", async () => {
      const a = slug("atual-a");
      const aId = await bareTenant(a);
      const b = slug("atual-b");
      await insertTenant(owner, b);
      const empty = await fetch(
        `${server.baseUrl}/v1/public/stores/${a}/legal`,
      );
      assert.equal(empty.status, 200);
      assert.deepEqual(await json(empty), {
        privacyPolicy: null,
        termsOfUse: null,
      });
      await publish(aId, "PRIVACY_POLICY", "p1", "Política 1");
      await publish(aId, "PRIVACY_POLICY", "p2", "Política 2");
      await publish(aId, "TERMS_OF_USE", "t1", "Termos 1");
      const current = await fetch(
        `${server.baseUrl}/v1/public/stores/${a}/legal`,
      );
      assert.equal(current.headers.get("cache-control"), "no-cache");
      const body = await json(current);
      assert.deepEqual(
        [
          body.privacyPolicy.version,
          body.privacyPolicy.body,
          body.termsOfUse.version,
        ],
        ["p2", "Política 2", "t1"],
      );
      const other = await json(
        await fetch(`${server.baseUrl}/v1/public/stores/${b}/legal`),
      );
      assert.equal(other.privacyPolicy.version, TEST_LEGAL_VERSION);
      for (const status of ["SUSPENDED", "CLOSED", "ONBOARDING"]) {
        const name = slug(status.toLowerCase());
        const id = await bareTenant(
          name,
          status === "CLOSED" ? "ACTIVE" : status,
        );
        if (status === "CLOSED")
          await owner.em
            .getConnection()
            .execute("update tenants set status = 'CLOSED' where id = ?", [id]);
        await runInTenant(owner, id, (em) =>
          em.execute(
            `insert into legal_documents (tenant_id, kind, version, revision, body, body_sha256)
           values (?, 'PRIVACY_POLICY', 'v1', 1, 'Texto', sha256('Texto'::bytea))`,
            [id],
          ),
        );
        const response = await fetch(
          `${server.baseUrl}/v1/public/stores/${name}/legal`,
        );
        assert.equal(response.status, 200, status);
        const html = await page(name, "privacidade");
        assert.equal(html.status, 200, status);
      }
    });

    it("signs up only with the current versions and records the exact documents", async () => {
      const store = slug("cadastro");
      const tenantId = await bareTenant(store);
      const unavailable = await register(store);
      assert.equal(unavailable.status, 409);
      assert.equal(
        (await json(unavailable)).code,
        "LEGAL_DOCUMENTS_UNAVAILABLE",
      );
      const privacy = await publish(
        tenantId,
        "PRIVACY_POLICY",
        TEST_LEGAL_VERSION,
        "Política",
      );
      const terms = await publish(
        tenantId,
        "TERMS_OF_USE",
        TEST_LEGAL_VERSION,
        "Termos",
      );
      const missing = await register(store, { termsOfUseVersion: undefined });
      assert.equal(missing.status, 422);
      assert.deepEqual(
        (await json(missing)).details.errors.map(
          (e: { path: string }) => e.path,
        ),
        ["termsOfUseVersion"],
      );
      const stale = await register(store, { termsOfUseVersion: "2025-01" });
      assert.equal(stale.status, 409);
      const staleBody = await json(stale);
      assert.equal(staleBody.code, "LEGAL_VERSION_OUTDATED");
      assert.deepEqual(staleBody.details, {
        privacyPolicyVersion: TEST_LEGAL_VERSION,
        termsOfUseVersion: TEST_LEGAL_VERSION,
      });
      const customer = await signedUp(store);
      const accepted = await runInTenant(owner, tenantId, (em) =>
        em.execute<{ documentId: string }[]>(
          `select a.document_id as "documentId" from customer_legal_acceptances a
           join customers c on c.id = a.customer_id where c.email = ? order by 1`,
          [customer.email],
        ),
      );
      assert.deepEqual(
        accepted.map((row) => row.documentId),
        [privacy.id, terms.id].sort(),
      );
      const profile = await json(await me(store, customer.accessToken));
      assert.equal(profile.privacyPolicyVersion, TEST_LEGAL_VERSION);
      assert.equal(profile.termsOfUseVersion, TEST_LEGAL_VERSION);
      assert.equal(profile.legalUpdateRequired, false);
    });

    it("asks for the new version after a publication and records its acceptance", async () => {
      const store = slug("nova-versao");
      const tenantId = await insertTenant(owner, store);
      const customer = await signedUp(store);
      await publish(tenantId, "TERMS_OF_USE", "2026-12", "Termos novos");
      assert.equal(
        (await json(await me(store, customer.accessToken))).legalUpdateRequired,
        true,
      );
      const accept = (body: unknown) =>
        fetch(
          `${server.baseUrl}/v1/customer/stores/${store}/me/legal-acceptances`,
          {
            method: "POST",
            headers: {
              ...bearer(customer.accessToken),
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          },
        );
      const old = await accept({
        privacyPolicyVersion: TEST_LEGAL_VERSION,
        termsOfUseVersion: TEST_LEGAL_VERSION,
      });
      assert.equal(old.status, 409);
      assert.equal((await json(old)).details.termsOfUseVersion, "2026-12");
      assert.equal(
        (await accept({ privacyPolicyVersion: TEST_LEGAL_VERSION })).status,
        422,
      );
      for (let attempt = 0; attempt < 2; attempt++)
        assert.equal(
          (
            await accept({
              privacyPolicyVersion: TEST_LEGAL_VERSION,
              termsOfUseVersion: "2026-12",
            })
          ).status,
          204,
        );
      const profile = await json(await me(store, customer.accessToken));
      assert.deepEqual(
        [profile.termsOfUseVersion, profile.legalUpdateRequired],
        ["2026-12", false],
      );
      const [{ count }] = (await runInTenant(owner, tenantId, (em) =>
        em.execute<{ count: number }[]>(
          "select count(*)::int as count from customer_legal_acceptances",
        ),
      )) as [{ count: number }];
      assert.equal(count, 3);
    });

    it("renders the documents as escaped HTML under a strict policy", async () => {
      const store = slug("pagina");
      const tenantId = await bareTenant(store);
      const missing = await page(store, "termos");
      assert.equal(missing.status, 404);
      assert.match(await missing.text(), /ainda não publicou/);
      await publish(
        tenantId,
        "TERMS_OF_USE",
        "2026-11",
        '## Uso <b>do app</b>\n\nParágrafo com <script>alert(1)</script> e "aspas".\n\n- item & mais',
      );
      const response = await page(store, "termos");
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type")!,
        /^text\/html; charset=utf-8/,
      );
      const csp = response.headers.get("content-security-policy")!;
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /style-src 'sha256-[A-Za-z0-9+/=]+'/);
      assert.match(csp, /frame-ancestors 'none'/);
      const html = await response.text();
      assert.match(html, /<h2>Uso &lt;b&gt;do app&lt;\/b&gt;<\/h2>/);
      assert.match(
        html,
        /&lt;script&gt;alert\(1\)&lt;\/script&gt; e &quot;aspas&quot;/,
      );
      assert.match(html, /<li>item &amp; mais<\/li>/);
      assert.match(html, /Versão 2026-11/);
      assert.equal(html.includes("<script>"), false);
      const unknown = await page("loja-que-nao-existe", "privacidade");
      assert.equal(unknown.status, 404);
      assert.match(unknown.headers.get("content-type")!, /^text\/html/);
      assert.match(await unknown.text(), /Página não encontrada/);
      // Outside the API prefix only: the JSON API keeps its own 404.
      assert.equal(
        (await fetch(`${server.baseUrl}/v1/lojas/${store}/termos`)).status,
        404,
      );
    });

    it("deletes the account from the web page like the app does, revealing no account", async () => {
      const a = slug("excluir-a");
      const aId = await insertTenant(owner, a);
      const b = slug("excluir-b");
      const bId = await insertTenant(owner, b);
      const form = await page(a, "excluir-conta");
      assert.equal(form.status, 200);
      assert.equal(form.headers.get("cache-control"), "no-store");
      assert.match(
        await form.text(),
        /<form method="post" action="\/lojas\/[a-z0-9-]+\/excluir-conta">/,
      );

      const customer = await signedUp(a);
      const victim = await signedUp(b);
      const unconfirmed = await deletionForm(a, {
        email: customer.email,
        password: PASSWORD,
      });
      assert.equal(unconfirmed.status, 422);
      const wrong = await deletionForm(a, {
        email: customer.email,
        password: "senha-errada-123",
        confirm: "yes",
      });
      assert.equal(wrong.status, 401);
      const wrongText = await wrong.text();
      assert.match(wrongText, /E-mail ou senha incorretos/);
      const unknown = await deletionForm(a, {
        email: `ninguem-${randomUUID()}@teste.invalid`,
        password: PASSWORD,
        confirm: "yes",
      });
      assert.equal(unknown.status, 401);
      assert.equal(await unknown.text(), wrongText);
      // Store B's credentials at store A's page find no account and delete nothing.
      const crossStore = await deletionForm(a, {
        email: victim.email,
        password: PASSWORD,
        confirm: "yes",
      });
      assert.equal(crossStore.status, 401);
      assert.equal(await customerStatus(bId, victim.email), "ACTIVE");
      // JSON is not a form: nothing happens.
      const asJson = await page(a, "excluir-conta", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: customer.email,
          password: PASSWORD,
          confirm: "yes",
        }),
      });
      assert.equal(asJson.status, 422);
      assert.equal(await customerStatus(aId, customer.email), "ACTIVE");

      const deleted = await deletionForm(a, {
        email: customer.email.toUpperCase(),
        password: PASSWORD,
        confirm: "yes",
      });
      assert.equal(deleted.status, 200);
      assert.match(await deleted.text(), /Conta excluída/);
      assert.equal(await customerStatus(aId, customer.email), "ABSENT");
      const [row] = await runInTenant(owner, aId, (em) =>
        em.execute<
          {
            status: string;
            email: string | null;
            open: number;
            acceptances: number;
          }[]
        >(
          `select c.status, c.email,
                (select count(*)::int from customer_sessions s where s.customer_id = c.id and s.revoked_at is null) as open,
                (select count(*)::int from customer_legal_acceptances l where l.customer_id = c.id) as acceptances
           from customers c order by c.created_at desc limit 1`,
        ),
      );
      assert.deepEqual(row, {
        status: "DELETED",
        email: null,
        open: 0,
        acceptances: 2,
      });
      assert.equal((await me(a, customer.accessToken)).status, 401);
      // Deleting again is the same refusal as a wrong password.
      assert.equal(
        (
          await deletionForm(a, {
            email: customer.email,
            password: PASSWORD,
            confirm: "yes",
          })
        ).status,
        401,
      );
    });

    it("keeps the deletion page working after a suspension, but not before going live", async () => {
      const suspended = slug("suspensa");
      const suspendedId = await insertTenant(owner, suspended);
      const customer = await signedUp(suspended);
      await owner.em
        .getConnection()
        .execute("update tenants set status = 'SUSPENDED' where id = ?", [
          suspendedId,
        ]);
      assert.equal((await page(suspended, "excluir-conta")).status, 200);
      const deleted = await deletionForm(suspended, {
        email: customer.email,
        password: PASSWORD,
        confirm: "yes",
      });
      assert.equal(deleted.status, 200);
      const onboarding = slug("preparo");
      await insertTenant(owner, onboarding, "ONBOARDING");
      assert.equal((await page(onboarding, "excluir-conta")).status, 200);
      const refused = await deletionForm(onboarding, {
        email: "x@teste.invalid",
        password: PASSWORD,
        confirm: "yes",
      });
      assert.equal(refused.status, 403);
      assert.match(await refused.text(), /Loja indisponível/);
    });

    it("throttles the deletion page with the sign-in limits", async () => {
      const store = slug("limite");
      await insertTenant(owner, store);
      const customer = await signedUp(store);
      for (let attempt = 0; attempt < 6; attempt++)
        assert.equal(
          (
            await deletionForm(store, {
              email: customer.email,
              password: `errada-${attempt}-123456`,
              confirm: "yes",
            })
          ).status,
          401,
        );
      const limited = await deletionForm(store, {
        email: customer.email,
        password: PASSWORD,
        confirm: "yes",
      });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.match(await limited.text(), /Muitas tentativas/);
      // The sign-in shares the counter.
      const login = await fetch(
        `${server.baseUrl}/v1/customer/stores/${store}/auth/login`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: customer.email, password: PASSWORD }),
        },
      );
      assert.equal(login.status, 429);
    });
  },
);
