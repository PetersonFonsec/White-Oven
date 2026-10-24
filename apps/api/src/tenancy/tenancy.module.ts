import { Global, Module } from "@nestjs/common";
import {
  StoreTenantGuard,
  TenantContextInterceptor,
} from "./store-tenant.guard";
import { TenantTransactions } from "./tenant-transaction";

@Global()
@Module({
  providers: [StoreTenantGuard, TenantContextInterceptor, TenantTransactions],
  exports: [StoreTenantGuard, TenantContextInterceptor, TenantTransactions],
})
export class TenancyModule {}
