import { createHash, randomBytes } from "node:crypto";

export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60;
/** Wrong codes allowed per challenge before the password must be entered again. */
export const MFA_CHALLENGE_ATTEMPTS = 5;
const MAX_CHALLENGES = 10_000;

interface Challenge {
  staffUserId: string;
  email: string;
  expiresAt: number;
  attemptsLeft: number;
  verifying: boolean;
}

/**
 * Second step of a login with MFA: after the password, the client gets an opaque single-use
 * token valid for 5 minutes and 5 codes. Kept in memory and keyed by SHA-256, like the login
 * throttle; a restart only asks for the password again.
 *
 * Lifecycle: `beginVerification` reserves the challenge synchronously (one verification at a
 * time; a concurrent one is refused), then exactly one of `consume` (factor accepted, session
 * committed), `recordFailure` (wrong code, counts an attempt) or `release` (unexpected error, no
 * attempt counted) ends the reservation.
 *
 * Instances: the MVP runs one API instance (system-overview.md). With several, a challenge only
 * exists in the instance that created it and fails closed elsewhere (401, sign in again); the
 * factors themselves stay single-use across instances because TOTP steps and recovery codes are
 * consumed in PostgreSQL under a row lock. Sticky routing or a shared store is needed to scale.
 */
export class MfaChallenges {
  private readonly challenges = new Map<string, Challenge>();

  constructor(private readonly now: () => number = Date.now) {}

  create(staffUserId: string, email: string): string {
    const token = randomBytes(32).toString("base64url");
    if (this.challenges.size >= MAX_CHALLENGES) this.prune();
    this.challenges.set(key(token), {
      staffUserId,
      email,
      expiresAt: this.now() + MFA_CHALLENGE_TTL_SECONDS * 1000,
      attemptsLeft: MFA_CHALLENGE_ATTEMPTS,
      verifying: false,
    });
    return token;
  }

  /** The pending challenge of `token`, or null when unknown, expired or used up. */
  peek(token: string): Readonly<Challenge> | null {
    return this.live(token);
  }

  /** Reserve a challenge synchronously before any asynchronous factor verification. */
  beginVerification(token: string): Readonly<Challenge> | null {
    const challenge = this.live(token);
    if (!challenge || challenge.verifying) return null;
    challenge.verifying = true;
    return { ...challenge };
  }

  private live(token: string): Challenge | null {
    const challenge = this.challenges.get(key(token));
    if (!challenge) return null;
    if (challenge.expiresAt <= this.now() || challenge.attemptsLeft <= 0) {
      this.challenges.delete(key(token));
      return null;
    }
    return challenge;
  }

  recordFailure(token: string): void {
    const challenge = this.challenges.get(key(token));
    if (!challenge) return;
    challenge.verifying = false;
    if (--challenge.attemptsLeft <= 0) this.challenges.delete(key(token));
  }

  /** Ends a reservation without counting an attempt (the check itself failed, not the code). */
  release(token: string): void {
    const challenge = this.challenges.get(key(token));
    if (challenge) challenge.verifying = false;
  }

  consume(token: string): void {
    this.challenges.delete(key(token));
  }

  private prune(): void {
    const now = this.now();
    for (const [id, challenge] of this.challenges)
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    // Still full: drop the oldest (insertion order) rather than grow without bound.
    for (const id of this.challenges.keys()) {
      if (this.challenges.size < MAX_CHALLENGES) break;
      this.challenges.delete(id);
    }
  }
}

const key = (token: string) =>
  createHash("sha256").update(token).digest("base64url");
