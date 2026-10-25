import { Global, Module } from "@nestjs/common";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { AccessTokens } from "./access-token";
import { LoginThrottle } from "./login-throttle";
import { MfaChallenges } from "./mfa-challenges";
import {
  AdminMeController,
  PlatformMeController,
  StaffAuthController,
} from "./staff-auth.controller";
import { StaffAuth } from "./staff-auth.service";
import { StaffMfa } from "./staff-mfa.service";
import { PlatformGuard, StaffGuard } from "./staff.guard";
import { SecretBox } from "./totp";

@Global()
@Module({
  controllers: [StaffAuthController, AdminMeController, PlatformMeController],
  providers: [
    {
      provide: AccessTokens,
      inject: [API_CONFIG],
      // Outside production a missing key means an ephemeral one (loadConfig enforces it there).
      useFactory: (config: ApiConfig) =>
        config.auth.accessTokenPrivateKey
          ? new AccessTokens(config.auth.accessTokenPrivateKey)
          : AccessTokens.ephemeral(),
    },
    {
      provide: SecretBox,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        config.auth.mfaEncryptionKey
          ? SecretBox.fromBytes(config.auth.mfaEncryptionKey)
          : SecretBox.ephemeral(),
    },
    { provide: LoginThrottle, useFactory: () => new LoginThrottle() },
    { provide: MfaChallenges, useFactory: () => new MfaChallenges() },
    StaffAuth,
    StaffMfa,
    StaffGuard,
    PlatformGuard,
  ],
  exports: [AccessTokens, StaffAuth, StaffGuard, PlatformGuard],
})
export class AuthModule {}
