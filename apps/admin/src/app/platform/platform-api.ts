import { HttpClient, HttpHeaders } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";

const TENANTS = "/v1/platform/tenants";
const INVITES = "/v1/platform/invites";

export interface PlatformTenant {
  id: string;
  slug: string;
  displayName: string;
  status: "ONBOARDING" | "ACTIVE" | "SUSPENDED";
  createdAt: string;
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
