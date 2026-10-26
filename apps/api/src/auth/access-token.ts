import {
  type KeyObject,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const ACCESS_TOKEN_ISSUER = "whiteoven-api";
export const STAFF_AUDIENCE = "whiteoven-admin";
/** Customer tokens are for the store apps; a staff route never accepts them, nor the reverse. */
export const CUSTOMER_AUDIENCE = "whiteoven-app";

/** Claims of a staff access token (system-overview.md, "Regras"). Nothing personal. */
export interface StaffAccessClaims {
  sub: string;
  typ: "staff";
  /** Active tenant, validated against an ACTIVE membership on every request on this request. */
  tid: string | null;
  sid: string;
  /** True only when the session was authenticated with a second factor (M1.4 MFA). */
  mfa: boolean;
}

/** Claims of a customer access token (M4.2, ADR 0017): always bound to one tenant. */
export interface CustomerAccessClaims {
  sub: string;
  typ: "customer";
  tid: string;
  sid: string;
}

interface Registered {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}
/** What a signed payload may carry, before the audience-specific checks. */
interface WireClaims extends Registered {
  sub?: string;
  typ?: string;
  tid?: string | null;
  sid?: string;
  mfa?: boolean;
}

const HEADER = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Compact JWS with a single fixed algorithm (EdDSA/Ed25519), built on node:crypto. Verification
 * compares the header byte for byte, so `alg: none` or algorithm confusion cannot be negotiated.
 */
export class AccessTokens {
  private readonly publicKey: KeyObject;

  constructor(
    private readonly privateKey: KeyObject,
    private readonly now: () => number = Date.now,
  ) {
    this.publicKey = createPublicKey(privateKey);
  }

  /** Development and tests only: a key that lives as long as the process. */
  static ephemeral(now?: () => number): AccessTokens {
    return new AccessTokens(generateKeyPairSync("ed25519").privateKey, now);
  }

  issue(claims: StaffAccessClaims): { token: string; expiresIn: number } {
    return this.sign(claims, STAFF_AUDIENCE);
  }

  issueCustomer(claims: CustomerAccessClaims): {
    token: string;
    expiresIn: number;
  } {
    return this.sign(claims, CUSTOMER_AUDIENCE);
  }

  private sign(
    claims: StaffAccessClaims | CustomerAccessClaims,
    aud: string,
  ): { token: string; expiresIn: number } {
    const iat = Math.floor(this.now() / 1000);
    const payload: WireClaims = {
      ...claims,
      iss: ACCESS_TOKEN_ISSUER,
      aud,
      iat,
      exp: iat + ACCESS_TOKEN_TTL_SECONDS,
    };
    const signingInput = `${HEADER}.${base64url(JSON.stringify(payload))}`;
    const signature = sign(null, Buffer.from(signingInput), this.privateKey);
    return {
      token: `${signingInput}.${signature.toString("base64url")}`,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /** Returns the claims of a valid, unexpired staff token, or null for anything else. */
  verify(token: string): StaffAccessClaims | null {
    const claims = this.decode(token, STAFF_AUDIENCE);
    if (
      !claims ||
      claims.typ !== "staff" ||
      !(
        claims.tid === null ||
        (typeof claims.tid === "string" && UUID.test(claims.tid))
      ) ||
      typeof claims.mfa !== "boolean"
    )
      return null;
    return {
      sub: claims.sub!,
      typ: "staff",
      tid: claims.tid,
      sid: claims.sid!,
      mfa: claims.mfa,
    };
  }

  /** Returns the claims of a valid, unexpired customer token, or null for anything else. */
  verifyCustomer(token: string): CustomerAccessClaims | null {
    const claims = this.decode(token, CUSTOMER_AUDIENCE);
    if (
      !claims ||
      claims.typ !== "customer" ||
      typeof claims.tid !== "string" ||
      !UUID.test(claims.tid)
    )
      return null;
    return {
      sub: claims.sub!,
      typ: "customer",
      tid: claims.tid,
      sid: claims.sid!,
    };
  }

  /** Signature, issuer, audience, expiry and the `sub`/`sid` ids; the caller checks the rest. */
  private decode(token: string, audience: string): WireClaims | null {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== HEADER) return null;
    const [header, body, signature] = parts as [string, string, string];
    if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature))
      return null;
    const valid = verify(
      null,
      Buffer.from(`${header}.${body}`),
      this.publicKey,
      Buffer.from(signature, "base64url"),
    );
    if (!valid) return null;

    let claims: Partial<WireClaims>;
    try {
      claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    if (
      typeof claims !== "object" ||
      claims === null ||
      claims.iss !== ACCESS_TOKEN_ISSUER ||
      claims.aud !== audience ||
      typeof claims.sub !== "string" ||
      !UUID.test(claims.sub) ||
      typeof claims.sid !== "string" ||
      !UUID.test(claims.sid) ||
      typeof claims.exp !== "number" ||
      claims.exp <= nowSeconds
    )
      return null;
    return claims as WireClaims;
  }
}
