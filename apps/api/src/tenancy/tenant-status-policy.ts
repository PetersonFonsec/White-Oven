import type { MembershipRole } from "../auth/staff.entity";
import type { TenantStatus } from "./tenant.entity";

export type TenantCapability =
  | "publicMenu"
  | "createOrder"
  | "customerAccount"
  | "staffLogin"
  | "storeRead"
  | "catalogWrite"
  | "catalogAvailability"
  | "catalogPolicyWrite"
  | "storeSettingsWrite"
  | "storePause"
  | "teamManage"
  | "orderTransition"
  | "suspendedOrderClose"
  | "incidentWrite"
  | "platformRead"
  | "platformWrite";

export type TenantActor = MembershipRole | "CUSTOMER" | "PUBLIC" | "OPERATOR";

const ALL_STAFF: readonly MembershipRole[] = ["OWNER", "MANAGER", "STAFF"];
const STORE_WRITERS: readonly MembershipRole[] = ["OWNER", "MANAGER"];
const OWNER_ONLY: readonly MembershipRole[] = ["OWNER"];

/**
 * The single source of tenant capabilities by status (domain-model.md). Route guards call this
 * after authenticating the actor and checking its membership role.
 */
export const TenantStatusPolicy = {
  allows(
    status: TenantStatus,
    actor: TenantActor,
    capability: TenantCapability,
  ): boolean {
    switch (capability) {
      case "publicMenu":
        return (
          status === "ACTIVE" && (actor === "PUBLIC" || actor === "CUSTOMER")
        );
      case "createOrder":
        return status === "ACTIVE" && actor === "CUSTOMER";
      case "customerAccount":
        return (
          actor === "CUSTOMER" &&
          ["ACTIVE", "SUSPENDED", "CLOSED"].includes(status)
        );
      case "staffLogin":
        return (
          isStaffRole(actor) &&
          (status === "ONBOARDING" ||
            status === "ACTIVE" ||
            (status === "SUSPENDED" && actor === "OWNER"))
        );
      case "storeRead":
        return (
          isStaffRole(actor) &&
          (status === "ONBOARDING" ||
            status === "ACTIVE" ||
            (status === "SUSPENDED" && actor === "OWNER"))
        );
      case "catalogWrite":
        return (
          isStaffRole(actor) &&
          (status === "ONBOARDING" || status === "ACTIVE") &&
          STORE_WRITERS.includes(actor)
        );
      case "catalogAvailability":
        return (
          isStaffRole(actor) &&
          (status === "ONBOARDING" || status === "ACTIVE") &&
          ALL_STAFF.includes(actor)
        );
      case "catalogPolicyWrite":
        return (
          (status === "ONBOARDING" || status === "ACTIVE") &&
          OWNER_ONLY.includes(actor as MembershipRole)
        );
      case "storeSettingsWrite":
        return (
          isStaffRole(actor) &&
          (status === "ONBOARDING" || status === "ACTIVE") &&
          OWNER_ONLY.includes(actor)
        );
      case "storePause":
        return (
          isStaffRole(actor) &&
          (status === "ONBOARDING" || status === "ACTIVE") &&
          ALL_STAFF.includes(actor)
        );
      case "teamManage":
        return (
          isStaffRole(actor) &&
          (status === "ONBOARDING" || status === "ACTIVE") &&
          OWNER_ONLY.includes(actor)
        );
      case "orderTransition":
        return (
          isStaffRole(actor) && status === "ACTIVE" && ALL_STAFF.includes(actor)
        );
      case "suspendedOrderClose":
        return (
          isStaffRole(actor) &&
          status === "SUSPENDED" &&
          OWNER_ONLY.includes(actor)
        );
      case "incidentWrite":
        return (
          isStaffRole(actor) &&
          (status === "ACTIVE" || (status === "SUSPENDED" && actor === "OWNER"))
        );
      case "platformRead":
        return actor === "OPERATOR";
      case "platformWrite":
        return actor === "OPERATOR" && status !== "CLOSED";
    }
  },

  staffMayEnter(status: TenantStatus, role: MembershipRole): boolean {
    return this.allows(status, role, "staffLogin");
  },
} as const;

function isStaffRole(actor: TenantActor): actor is MembershipRole {
  return actor === "OWNER" || actor === "MANAGER" || actor === "STAFF";
}
