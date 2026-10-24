import { Migration } from "@mikro-orm/migrations";

/**
 * Staff MFA (M1.4 part B, ADR 0007): TOTP secret encrypted with AES-256-GCM under a key kept
 * outside the database (`AUTH_MFA_ENCRYPTION_KEY`), a pending secret during enrollment, the last
 * accepted time step (no code replay) and SHA-256 hashes of single-use recovery codes.
 * An enabled MFA always has a secret; an OPERATOR without `mfa_enabled_at` reaches only
 * enrollment (enforced by `StaffGuard`/`PlatformGuard`).
 */
export class Migration20261024030000_staff_mfa extends Migration {
  override up(): void {
    this.addSql(`
      alter table staff_users
        add column mfa_secret text,
        add column mfa_pending_secret text,
        add column mfa_enabled_at timestamptz,
        add column mfa_last_used_step bigint,
        add column mfa_recovery_code_hashes bytea[] not null default '{}',
        add constraint staff_users_mfa_enabled_has_secret
          check ((mfa_enabled_at is null) = (mfa_secret is null)),
        add constraint staff_users_mfa_secret_format
          check (mfa_secret is null or mfa_secret like 'v1.%'),
        add constraint staff_users_mfa_pending_secret_format
          check (mfa_pending_secret is null or mfa_pending_secret like 'v1.%'),
        add constraint staff_users_mfa_recovery_code_count
          check (cardinality(mfa_recovery_code_hashes) <= 10);
    `);
  }

  override down(): void {
    throw new Error("Migration20261024030000_staff_mfa is forward-only");
  }
}
