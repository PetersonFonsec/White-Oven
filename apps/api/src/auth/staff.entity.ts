import { defineEntity, p } from "@mikro-orm/core";
import { tenantFilters } from "../tenancy/tenant-filter";

export const PLATFORM_ROLES = ["NONE", "OPERATOR"] as const;
export const STAFF_USER_STATUSES = ["INVITED", "ACTIVE", "DISABLED"] as const;
export const MEMBERSHIP_ROLES = ["OWNER", "MANAGER", "STAFF"] as const;
export const MEMBERSHIP_STATUSES = ["INVITED", "ACTIVE", "REVOKED"] as const;
export const SESSION_REVOKED_REASONS = [
  "LOGOUT",
  "REFRESH_REUSE",
  "USER_DISABLED",
  "MFA_RESET",
  "TENANT_SUSPENDED",
  "MEMBERSHIP_REVOKED",
] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type SessionRevokedReason = (typeof SESSION_REVOKED_REASONS)[number];

/** Global staff identity (D-03); linked to tenants only through `Membership`. */
export const StaffUser = defineEntity({
  name: "StaffUser",
  tableName: "staff_users",
  properties: {
    id: p.uuid().primary(),
    email: p.text(),
    name: p.text(),
    passwordHash: p.text().lazy(),
    platformRole: p.enum([...PLATFORM_ROLES]),
    status: p.enum([...STAFF_USER_STATUSES]),
    lastLoginAt: p.datetime().nullable(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

/**
 * One login of a staff user. The refresh token is stored only as its SHA-256; it rotates on
 * every use, and presenting an old one revokes the session (`REFRESH_REUSE`).
 */
export const StaffSession = defineEntity({
  name: "StaffSession",
  tableName: "staff_sessions",
  properties: {
    id: p.uuid().primary(),
    staffUserId: p.uuid(),
    activeTenantId: p.uuid().nullable(),
    mfa: p.boolean(),
    refreshTokenHash: p.blob().lazy(),
    createdAt: p.datetime(),
    refreshedAt: p.datetime(),
    idleExpiresAt: p.datetime(),
    revokedAt: p.datetime().nullable(),
    revokedReason: p.enum([...SESSION_REVOKED_REASONS]).nullable(),
  },
});

/** Tenant entity: read and written only inside `runInTenant`/`TenantTransactions`. */
export const Membership = defineEntity({
  name: "Membership",
  tableName: "memberships",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    staffUserId: p.uuid(),
    role: p.enum([...MEMBERSHIP_ROLES]),
    status: p.enum([...MEMBERSHIP_STATUSES]),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
