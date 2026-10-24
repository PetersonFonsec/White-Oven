import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createSecretKey,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** RFC 6238 defaults understood by every authenticator app: SHA-1, 6 digits, 30 s. */
export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;
/** Accepts the previous and next step too, for clock drift. */
const DRIFT_STEPS = 1;
export const TOTP_ISSUER = "WhiteOven";
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit TOTP secret (RFC 4226 recommendation), base32 for authenticator apps. */
export const newTotpSecret = () => base32(randomBytes(20));

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", fromBase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const currentStep = (now = Date.now()) =>
  Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);

/**
 * The step a 6-digit `code` matches within the drift window, newer than `lastUsedStep` (a code
 * is accepted once: replays and older codes fail), or null.
 */
export function matchTotp(
  secret: string,
  code: string,
  lastUsedStep: number | null,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = currentStep(now);
  let matched: number | null = null;
  for (
    let step = current - DRIFT_STEPS;
    step <= current + DRIFT_STEPS;
    step++
  ) {
    const expected = Buffer.from(totpCode(secret, step));
    // Compare every candidate so timing does not reveal which step matched.
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === null)
      matched = step;
  }
  if (matched === null || (lastUsedStep !== null && matched <= lastUsedStep))
    return null;
  return matched;
}

export function otpauthUri(secret: string, account: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${TOTP_ISSUER}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
}

/** `xxxxx-xxxxx`, 50 random bits each; shown once, stored only as SHA-256. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const code = base32(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** Hash of a recovery code as typed: case, spaces and dashes do not matter. */
export const recoveryCodeHash = (code: string) =>
  createHash("sha256")
    .update(code.replace(/[\s-]/g, "").toLowerCase())
    .digest();

/**
 * AES-256-GCM for TOTP secrets at rest, with the staff user id as associated data, so a secret
 * copied to another row does not decrypt. Format: `v1.<iv>.<ciphertext>.<tag>` (base64url).
 */
export class SecretBox {
  constructor(private readonly key: KeyObject) {}

  static fromBytes(key: Buffer): SecretBox {
    return new SecretBox(createSecretKey(key));
  }

  static ephemeral(): SecretBox {
    return SecretBox.fromBytes(randomBytes(32));
  }

  seal(plaintext: string, owner: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(owner));
    const sealed = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return ["v1", iv, sealed, cipher.getAuthTag()]
      .map((part) =>
        typeof part === "string" ? part : part.toString("base64url"),
      )
      .join(".");
  }

  /** Null when the value was not sealed with this key for this owner. */
  open(sealed: string, owner: string): string | null {
    const [version, iv, data, tag] = sealed.split(".");
    if (version !== "v1" || !iv || !data || !tag) return null;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(owner));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(data, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      return null;
    }
  }
}
