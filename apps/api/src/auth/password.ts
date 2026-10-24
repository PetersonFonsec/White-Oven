import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id with the OWASP Password Storage Cheat Sheet minimum (m = 19 MiB, t = 2, p = 1). The
 * parameters live in each encoded hash, so raising them later only affects new hashes.
 */
const ARGON2ID = {
  algorithm: 2, // Algorithm.Argon2id: the package declares it as an ambient const enum
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 10;
/** Bounds hashing work per request; long passphrases still fit. */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * Small local deny list of common passwords that satisfy the length rule (system-overview.md:
 * "verificação contra lista de senhas vazadas comuns local"). Compared case-insensitively.
 */
const COMMON_PASSWORDS = new Set([
  "1234567890",
  "12345678910",
  "123456789a",
  "0123456789",
  "0987654321",
  "1111111111",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "qwertyuiop",
  "asdfghjkl1",
  "password12",
  "password123",
  "password1234",
  "passw0rd123",
  "senha12345",
  "senha123456",
  "minhasenha",
  "minhasenha123",
  "abc1234567",
  "abcdefghij",
  "iloveyou12",
  "brasil1234",
  "flamengo123",
  "corinthians",
  "palmeiras123",
  "whiteoven123",
  "pizzaria123",
  "admin12345",
  "administrator",
  "qwerty12345",
  "qwerty123456",
]);

/** Why `password` is not acceptable as a new password, or undefined. Never echoes the value. */
export function passwordProblem(password: string): string | undefined {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH)
    return `must have at least ${PASSWORD_MIN_LENGTH} characters`;
  if (length > PASSWORD_MAX_LENGTH)
    return `must have at most ${PASSWORD_MAX_LENGTH} characters`;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "is too common";
  return undefined;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password.normalize("NFC"), ARGON2ID);
}

/**
 * Hash checked when the e-mail does not exist, so unknown accounts cost the same time as wrong
 * passwords and the response time does not reveal which e-mails are registered.
 */
let dummyHash: Promise<string> | undefined;

/** Constant-shape check: always runs one Argon2id verification. */
export async function verifyPassword(
  encoded: string | null,
  password: string,
): Promise<boolean> {
  dummyHash ??= hashPassword("whiteoven-unknown-account-placeholder");
  const target = encoded ?? (await dummyHash);
  try {
    const ok = await verify(target, password.normalize("NFC"));
    return encoded !== null && ok;
  } catch {
    return false;
  }
}
