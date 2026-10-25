import { HttpClient, HttpHeaders } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import type { Role } from "../core/session";

const TEAM = "/v1/admin/team";
const INVITES = "/v1/team/invites";

export const TEAM_ROLES: readonly Role[] = ["OWNER", "MANAGER", "STAFF"];

export interface TeamMember {
  membershipId: string;
  name: string;
  email: string;
  role: Role;
  since: string;
  /** The signed-in OWNER's own row. */
  you: boolean;
}

export interface PendingInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export interface Team {
  members: TeamMember[];
  invites: PendingInvite[];
}

export interface CreatedInvite {
  invite: PendingInvite;
  /** Shown once: only its hash is stored. */
  inviteUrl: string;
  expiresIn: number;
}

export interface InvitePreview {
  storeName: string;
  role: Role;
  email: string;
  /** The invitee signs in with that account and accepts, instead of creating one. */
  accountExists: boolean;
  expiresAt: string;
}

export interface RedeemedInvite {
  storeName: string;
  role: Role;
  newAccount: boolean;
}

@Injectable({ providedIn: "root" })
export class TeamApi {
  private readonly http = inject(HttpClient);

  team(): Promise<Team> {
    return firstValueFrom(this.http.get<Team>(TEAM));
  }

  /** A retry with the same key and body returns the same link (the API keeps no token). */
  invite(
    email: string,
    role: Role,
    idempotencyKey: string,
  ): Promise<CreatedInvite> {
    return firstValueFrom(
      this.http.post<CreatedInvite>(
        `${TEAM}/invites`,
        { email, role },
        { headers: new HttpHeaders({ "Idempotency-Key": idempotencyKey }) },
      ),
    );
  }

  async cancelInvite(inviteId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(`${TEAM}/invites/${encodeURIComponent(inviteId)}`),
    );
  }

  async changeRole(membershipId: string, role: Role): Promise<void> {
    await firstValueFrom(
      this.http.patch<void>(
        `${TEAM}/members/${encodeURIComponent(membershipId)}`,
        { role },
      ),
    );
  }

  async revoke(membershipId: string): Promise<void> {
    await firstValueFrom(
      this.http.delete<void>(
        `${TEAM}/members/${encodeURIComponent(membershipId)}`,
      ),
    );
  }

  preview(token: string): Promise<InvitePreview> {
    return firstValueFrom(
      this.http.post<InvitePreview>(`${INVITES}/preview`, { token }),
    );
  }

  /** A new person: creates the account the invite is for. */
  redeem(
    token: string,
    name: string,
    password: string,
  ): Promise<RedeemedInvite> {
    return firstValueFrom(
      this.http.post<RedeemedInvite>(`${INVITES}/redeem`, {
        token,
        name,
        password,
      }),
    );
  }

  /** A person with an account, signed in: the API takes the identity from the session. */
  accept(token: string): Promise<RedeemedInvite> {
    return firstValueFrom(
      this.http.post<RedeemedInvite>(`${INVITES}/accept`, { token }),
    );
  }
}
