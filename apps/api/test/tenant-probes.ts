import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpStatus,
  Injectable,
  Module,
  Param,
  Patch,
  UseGuards,
} from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { defineEntity, p } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Request } from "express";
import { tenantIsolationSql } from "../src/database/tenant-isolation-sql";
import { ApiError } from "../src/errors/api-error";
import { StoreTenant, claimTenant } from "../src/tenancy/store-tenant.guard";
import { tenantFilters } from "../src/tenancy/tenant-filter";
import { TenantTransactions } from "../src/tenancy/tenant-transaction";

/**
 * Test-only tenant tables. Production has no tenant table yet (memberships arrive in M1.4,
 * catalog in M2.3); these are built exactly as a real migration must build one, so the
 * required isolation tests exercise the same SQL, filter and guards. Each real tenant table
 * must join the matrix and the coverage test in its own PR.
 */
export const PROBE_TABLES_SQL = [
  `create table isolation_probe_flavors (
     id uuid primary key default gen_random_uuid(),
     tenant_id uuid not null references tenants (id),
     name text not null,
     constraint isolation_probe_flavors_tenant_id_id_key unique (tenant_id, id)
   );`,
  ...tenantIsolationSql("isolation_probe_flavors"),
  `create table isolation_probe_items (
     id uuid primary key default gen_random_uuid(),
     tenant_id uuid not null references tenants (id),
     flavor_id uuid not null,
     constraint isolation_probe_items_flavor_fkey foreign key (tenant_id, flavor_id)
       references isolation_probe_flavors (tenant_id, id)
   );`,
  ...tenantIsolationSql("isolation_probe_items"),
];

export async function createProbeTables(owner: MikroORM): Promise<void> {
  const connection = owner.em.getConnection();
  for (const statement of PROBE_TABLES_SQL) await connection.execute(statement);
}

export const ProbeFlavor = defineEntity({
  name: "IsolationProbeFlavor",
  tableName: "isolation_probe_flavors",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    name: p.text(),
  },
});

const notFound = () =>
  new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "Resource not found.");

@Controller("public/stores/:storeSlug/isolation-probe")
class PublicProbeController {
  constructor(private readonly tenant: TenantTransactions) {}

  @Get()
  @StoreTenant()
  list() {
    return this.tenant.run(async (em) => {
      const rows = await em.find(ProbeFlavor, {}, { orderBy: { name: "asc" } });
      return rows.map((row) => row.name);
    });
  }

  @Get(":id")
  @StoreTenant()
  read(@Param("id") id: string) {
    return this.tenant.run(async (em) => {
      const row = await em.findOne(ProbeFlavor, { id });
      if (!row) throw notFound();
      return { id: row.id, name: row.name };
    });
  }

  @Patch(":id")
  @StoreTenant()
  rename(@Param("id") id: string, @Body() body: { name: string }) {
    return this.tenant.run(async (em) => {
      const row = await em.findOne(ProbeFlavor, { id });
      if (!row) throw notFound();
      row.name = body.name;
      await em.flush();
      return { id: row.id, name: row.name };
    });
  }
}

/** Stands in for the customer token guard (M1.4+): the header plays the token's `tid` claim. */
@Injectable()
class TestTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const tid = req.get("x-test-token-tid");
    if (!tid) return false;
    claimTenant(req, tid);
    return true;
  }
}

@Controller("customer/stores/:storeSlug/isolation-probe")
@UseGuards(TestTokenGuard)
class CustomerProbeController {
  constructor(private readonly tenant: TenantTransactions) {}

  @Get(":id")
  @StoreTenant()
  read(@Param("id") id: string) {
    return this.tenant.run(async (em) => {
      const row = await em.findOne(ProbeFlavor, { id });
      if (!row) throw notFound();
      return { id: row.id, name: row.name };
    });
  }
}

@Module({
  imports: [DiscoveryModule],
  controllers: [PublicProbeController, CustomerProbeController],
  providers: [TestTokenGuard],
})
export class TenantProbeModule {}
