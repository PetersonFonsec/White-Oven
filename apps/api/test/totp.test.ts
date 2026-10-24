import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  SecretBox,
  base32,
  fromBase32,
  matchTotp,
  newRecoveryCodes,
  recoveryCodeHash,
  totpCode,
} from "../src/auth/totp";

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890", truncated to 6 digits.
const RFC_SECRET = base32(Buffer.from("12345678901234567890"));

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    for (const [time, code] of [
      [59, "287082"],
      [1111111109, "081804"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ] as const)
      assert.equal(
        totpCode(RFC_SECRET, Math.floor(time / 30)),
        code,
        String(time),
      );
  });

  it("accepts one step of drift, rejects older steps and replays", () => {
    const now = 1234567890_000;
    const step = Math.floor(now / 30_000);
    for (const offset of [-1, 0, 1])
      assert.equal(
        matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + offset), null, now),
        step + offset,
      );
    assert.equal(
      matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), null, now),
      null,
    );
    assert.equal(
      matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), step, now),
      null,
    );
    assert.equal(
      matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), step, now),
      step + 1,
    );
    for (const bad of ["", "12345", "1234567", "abcdef"])
      assert.equal(matchTotp(RFC_SECRET, bad, null, now), null);
  });

  it("round-trips base32", () => {
    const bytes = randomBytes(20);
    assert.deepEqual(fromBase32(base32(bytes)), bytes);
    assert.throws(() => fromBase32("abc1"));
  });
});

describe("recovery codes", () => {
  it("are 10 distinct codes whose hash ignores case, spaces and dashes", () => {
    const codes = newRecoveryCodes();
    assert.equal(new Set(codes).size, 10);
    const code = codes[0]!;
    assert.deepEqual(
      recoveryCodeHash(` ${code.toUpperCase().replace("-", " ")} `),
      recoveryCodeHash(code),
    );
  });
});

describe("SecretBox", () => {
  it("seals with a fresh IV and opens only with the same key and owner", () => {
    const box = SecretBox.ephemeral();
    const a = box.seal("SECRET", "owner-a");
    assert.notEqual(box.seal("SECRET", "owner-a"), a);
    assert.equal(box.open(a, "owner-a"), "SECRET");
    assert.equal(box.open(a, "owner-b"), null);
    assert.equal(SecretBox.ephemeral().open(a, "owner-a"), null);
    const [v, iv, data, tag] = a.split(".");
    const flipped = Buffer.from(data!, "base64url");
    flipped[0]! ^= 1;
    assert.equal(
      box.open(
        [v, iv, flipped.toString("base64url"), tag].join("."),
        "owner-a",
      ),
      null,
    );
    assert.equal(box.open("garbage", "owner-a"), null);
  });
});
