import { Injectable } from "@angular/core";

/**
 * The invite token while its owner signs in to accept it. Memory only, like the access token:
 * the sign-in happens in the same page, so it survives the navigation and nothing else.
 */
@Injectable({ providedIn: "root" })
export class PendingTeamInvite {
  private token: string | null = null;

  hold(token: string): void {
    this.token = token;
  }

  waiting(): boolean {
    return this.token !== null;
  }

  /** The token, once; null when none is waiting. */
  take(): string | null {
    const token = this.token;
    this.token = null;
    return token;
  }
}
