import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MembershipRole } from "../src/auth/staff.entity";
import {
  TenantStatusPolicy,
  type TenantActor,
  type TenantCapability,
} from "../src/tenancy/tenant-status-policy";
import type { TenantStatus } from "../src/tenancy/tenant.entity";

const statuses: TenantStatus[] = [
  "ONBOARDING",
  "ACTIVE",
  "SUSPENDED",
  "CLOSED",
];
const actors: TenantActor[] = [
  "PUBLIC",
  "CUSTOMER",
  "OWNER",
  "MANAGER",
  "STAFF",
  "OPERATOR",
];

const expected: Record<
  TenantCapability,
  Partial<Record<TenantStatus, readonly TenantActor[]>>
> = {
  publicMenu: { ACTIVE: ["PUBLIC", "CUSTOMER"] },
  createOrder: { ACTIVE: ["CUSTOMER"] },
  customerAccount: {
    ACTIVE: ["CUSTOMER"],
    SUSPENDED: ["CUSTOMER"],
    CLOSED: ["CUSTOMER"],
  },
  staffLogin: {
    ONBOARDING: ["OWNER", "MANAGER", "STAFF"],
    ACTIVE: ["OWNER", "MANAGER", "STAFF"],
    SUSPENDED: ["OWNER"],
  },
  storeRead: {
    ONBOARDING: ["OWNER", "MANAGER", "STAFF"],
    ACTIVE: ["OWNER", "MANAGER", "STAFF"],
    SUSPENDED: ["OWNER"],
  },
  catalogWrite: {
    ONBOARDING: ["OWNER", "MANAGER"],
    ACTIVE: ["OWNER", "MANAGER"],
  },
  catalogAvailability: {
    ONBOARDING: ["OWNER", "MANAGER", "STAFF"],
    ACTIVE: ["OWNER", "MANAGER", "STAFF"],
  },
  catalogPolicyWrite: {
    ONBOARDING: ["OWNER"],
    ACTIVE: ["OWNER"],
  },
  storeSettingsWrite: {
    ONBOARDING: ["OWNER"],
    ACTIVE: ["OWNER"],
  },
  storePause: {
    ONBOARDING: ["OWNER", "MANAGER", "STAFF"],
    ACTIVE: ["OWNER", "MANAGER", "STAFF"],
  },
  teamManage: {
    ONBOARDING: ["OWNER"],
    ACTIVE: ["OWNER"],
  },
  orderTransition: { ACTIVE: ["OWNER", "MANAGER", "STAFF"] },
  suspendedOrderClose: { SUSPENDED: ["OWNER"] },
  incidentWrite: {
    ACTIVE: ["OWNER", "MANAGER", "STAFF"],
    SUSPENDED: ["OWNER"],
  },
  platformRead: {
    ONBOARDING: ["OPERATOR"],
    ACTIVE: ["OPERATOR"],
    SUSPENDED: ["OPERATOR"],
    CLOSED: ["OPERATOR"],
  },
  platformWrite: {
    ONBOARDING: ["OPERATOR"],
    ACTIVE: ["OPERATOR"],
    SUSPENDED: ["OPERATOR"],
  },
};

describe("TenantStatusPolicy", () => {
  it("matches every status, actor and capability in the domain matrix", () => {
    for (const [capability, byStatus] of Object.entries(expected) as [
      TenantCapability,
      Partial<Record<TenantStatus, readonly TenantActor[]>>,
    ][]) {
      for (const status of statuses) {
        for (const actor of actors) {
          assert.equal(
            TenantStatusPolicy.allows(status, actor, capability),
            byStatus[status]?.includes(actor) ?? false,
            `${status} / ${actor} / ${capability}`,
          );
        }
      }
    }
  });

  it("exposes the login matrix for every store role", () => {
    const roles: MembershipRole[] = ["OWNER", "MANAGER", "STAFF"];
    const allowed: Record<TenantStatus, readonly MembershipRole[]> = {
      ONBOARDING: roles,
      ACTIVE: roles,
      SUSPENDED: ["OWNER"],
      CLOSED: [],
    };
    for (const status of statuses)
      for (const role of roles)
        assert.equal(
          TenantStatusPolicy.staffMayEnter(status, role),
          allowed[status].includes(role),
          `${status} / ${role}`,
        );
  });
});
