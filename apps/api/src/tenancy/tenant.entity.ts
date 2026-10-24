import { defineEntity, p } from "@mikro-orm/core";

export const TENANT_STATUSES = [
  "ONBOARDING",
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** `^[a-z0-9-]{3,40}$`, same as the `tenants_slug_format` constraint. */
export const TENANT_SLUG = /^[a-z0-9-]{3,40}$/;

/**
 * Global entity (no `tenant_id`, no RLS): resolved by slug before a tenant context exists.
 * The API role can only read it (see Migration20261024010000_tenants).
 */
export const Tenant = defineEntity({
  name: "Tenant",
  tableName: "tenants",
  properties: {
    id: p.uuid().primary(),
    slug: p.text(),
    displayName: p.text(),
    status: p.enum([...TENANT_STATUSES]),
    timezone: p.text(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
