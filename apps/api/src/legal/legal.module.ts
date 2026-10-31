import { Module } from "@nestjs/common";
import { CustomerModule } from "../customer/customer.module";
import { LegalDocuments } from "./legal-documents.service";
import {
  LegalPageExceptionFilter,
  LegalPagesController,
  PublicLegalController,
} from "./legal.controller";

@Module({
  imports: [CustomerModule],
  controllers: [PublicLegalController, LegalPagesController],
  providers: [LegalDocuments, LegalPageExceptionFilter],
})
export class LegalModule {}
