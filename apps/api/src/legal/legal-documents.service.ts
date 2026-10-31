import { Injectable } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  LegalDocument,
  LegalDocumentKind,
  StoreLegalDocuments,
} from "@whiteoven/contracts";
import { TenantTransactions } from "../tenancy/tenant-transaction";

export interface CurrentLegalDocument extends LegalDocument {
  id: string;
}

export interface CurrentLegalDocuments {
  privacyPolicy: CurrentLegalDocument | null;
  termsOfUse: CurrentLegalDocument | null;
}

/**
 * The store's current privacy policy and terms of use (ADR 0030): the highest revision of each
 * kind, read in the caller's tenant transaction, so RLS keeps every other store's text out.
 */
export async function currentLegalDocuments(
  em: Pick<EntityManager, "execute">,
): Promise<CurrentLegalDocuments> {
  const rows = await em.execute<
    {
      id: string;
      kind: LegalDocumentKind;
      version: string;
      body: string;
      publishedAt: Date;
    }[]
  >(
    `select distinct on (kind) id, kind, version, body, published_at as "publishedAt"
       from legal_documents
      order by kind, revision desc`,
  );
  const of = (kind: LegalDocumentKind): CurrentLegalDocument | null => {
    const row = rows.find((candidate) => candidate.kind === kind);
    return row
      ? {
          id: row.id,
          kind: row.kind,
          version: row.version,
          body: row.body,
          publishedAt: new Date(row.publishedAt).toISOString(),
        }
      : null;
  };
  return {
    privacyPolicy: of("PRIVACY_POLICY"),
    termsOfUse: of("TERMS_OF_USE"),
  };
}

const publicDocument = (
  document: CurrentLegalDocument | null,
): LegalDocument | null =>
  document
    ? {
        kind: document.kind,
        version: document.version,
        body: document.body,
        publishedAt: document.publishedAt,
      }
    : null;

@Injectable()
export class LegalDocuments {
  constructor(private readonly transactions: TenantTransactions) {}

  /** The current documents and the store's display name, for the app and the web pages. */
  async current(): Promise<StoreLegalDocuments & { storeName: string }> {
    return this.transactions.run(async (em) => {
      const documents = await currentLegalDocuments(em);
      const [store] = await em.execute<{ name: string }[]>(
        `select display_name as name from tenants
          where id = current_setting('app.tenant_id')::uuid`,
      );
      return {
        storeName: store!.name,
        privacyPolicy: publicDocument(documents.privacyPolicy),
        termsOfUse: publicDocument(documents.termsOfUse),
      };
    });
  }
}
