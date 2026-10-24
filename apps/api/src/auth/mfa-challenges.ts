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
}

/**
 * Second step of a login with MFA: after the password, the client gets an opaque single-use
 * token valid for 5 minutes and 5 codes. Kept in memory and keyed by SHA-256, like the login
 * throttle (one API instance in the MVP); a restart only asks for the password again.
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
    });
    return token;
  }

  /** The pending challenge of `token`, or null when unknown, expired or used up. */
  peek(token: string): Readonly<Challenge> | null {
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
    if (challenge && --challenge.attemptsLeft <= 0)
      this.challenges.delete(key(token));
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
