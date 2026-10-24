import { Global, Module } from "@nestjs/common";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { AccessTokens } from "./access-token";
import { LoginThrottle } from "./login-throttle";
import {
  AdminMeController,
  StaffAuthController,
} from "./staff-auth.controller";
import { StaffAuth } from "./staff-auth.service";
import { StaffGuard } from "./staff.guard";

@Global()
@Module({
  controllers: [StaffAuthController, AdminMeController],
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
    { provide: LoginThrottle, useFactory: () => new LoginThrottle() },
    StaffAuth,
    StaffGuard,
  ],
  exports: [AccessTokens, StaffAuth, StaffGuard],
})
export class AuthModule {}
