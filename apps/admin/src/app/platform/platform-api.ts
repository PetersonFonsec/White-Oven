import { HttpClient, HttpHeaders } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";

const TENANTS = "/v1/platform/tenants";
const INVITES = "/v1/platform/invites";
const PLANS = "/v1/platform/plans";

export type PlanCode = "FLEX" | "PRO";

export interface TenantPlanRef {
  code: PlanCode;
  validFrom: string;
}

export interface PlatformTenant {
  id: string;
  slug: string;
  displayName: string;
  status: "ONBOARDING" | "ACTIVE" | "SUSPENDED";
  createdAt: string;
  /** Current plan; null before the first subscription. */
  plan: TenantPlanRef | null;
  /** Plan that replaces the current one at `validFrom`. */
  scheduledPlan: TenantPlanRef | null;
}

export interface Plan {
  code: PlanCode;
  feeBasisPoints: number;
  monthlyFeeCents: number;
}

export interface PlanSubscription extends Plan {
  id: string;
  validFrom: string;
  validTo: string | null;
  createdAt: string;
}

export interface PlanChange {
  subscriptionId: string;
  plan: PlanCode;
  validFrom: string;
  changed: boolean;
}

export interface NewPlatformTenant {
  slug: string;
  displayName: string;
  ownerEmail: string;
}

export interface OwnerInvite {
  tenantId: string;
  inviteUrl: string;
  expiresIn: number;
}

export interface RedeemedOwnerInvite {
  staffUserId: string;
  tenantId: string;
}

@Injectable({ providedIn: "root" })
export class PlatformApi {
  private readonly http = inject(HttpClient);

  listTenants(): Promise<PlatformTenant[]> {
    return firstValueFrom(this.http.get<PlatformTenant[]>(TENANTS));
  }

  createTenant(
    input: NewPlatformTenant,
    idempotencyKey: string,
  ): Promise<OwnerInvite> {
    return firstValueFrom(
      this.http.post<OwnerInvite>(TENANTS, input, {
        headers: new HttpHeaders({ "Idempotency-Key": idempotencyKey }),
      }),
    );
  }

  async changeStatus(
    tenantId: string,
    status: "ACTIVE" | "SUSPENDED",
  ): Promise<void> {
    await firstValueFrom(
      this.http.patch<void>(
        `${TENANTS}/${encodeURIComponent(tenantId)}/status`,
        { status },
      ),
    );
  }

  listPlans(): Promise<Plan[]> {
    return firstValueFrom(this.http.get<Plan[]>(PLANS));
  }

  listPlanSubscriptions(tenantId: string): Promise<PlanSubscription[]> {
    return firstValueFrom(
      this.http.get<PlanSubscription[]>(
        `${TENANTS}/${encodeURIComponent(tenantId)}/plans`,
      ),
    );
  }

  changePlan(tenantId: string, plan: PlanCode): Promise<PlanChange> {
    return firstValueFrom(
      this.http.put<PlanChange>(
        `${TENANTS}/${encodeURIComponent(tenantId)}/plan`,
        { plan },
      ),
    );
  }

  redeemInvite(
    token: string,
    name: string,
    password: string,
  ): Promise<RedeemedOwnerInvite> {
    return firstValueFrom(
      this.http.post<RedeemedOwnerInvite>(`${INVITES}/redeem`, {
        token,
        name,
        password,
      }),
    );
  }
}
