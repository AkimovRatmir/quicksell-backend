import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import {
  DRIZZLE,
  type DrizzleDB,
  type DrizzleExecutor,
} from '../database/drizzle.constants';
import {
  type NewUserConsent,
  userConsents,
  type UserConsentRow,
} from '../database/schema';
import {
  allDocuments,
  type ConsentContext,
  type LegalDocument,
  LEGAL_DOCUMENTS,
  requiredDocuments,
} from './legal-documents';
import { AcceptedDocumentDto } from './dto/accepted-document.dto';

/** Request evidence stored alongside an acceptance. */
export interface ConsentRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class LegalService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Current version of every document — what the frontend should link to. */
  documents(): LegalDocument[] {
    return allDocuments();
  }

  /**
   * Write the consent rows for one ticked checkbox: one row per document the
   * context requires, stamped with the version live at this moment.
   *
   * `exec` lets registration write these inside its own transaction, so an
   * account can never exist without the consent that created it.
   *
   * If the caller echoes back `acceptedDocuments`, they must match the current
   * versions exactly. A mismatch means the documents were republished while
   * the form sat open, and we refuse rather than record consent to a text the
   * user never saw.
   */
  async record(args: {
    userId: string;
    context: ConsentContext;
    acceptedDocuments?: AcceptedDocumentDto[];
    meta?: ConsentRequestMeta;
    exec?: DrizzleExecutor;
  }): Promise<UserConsentRow[]> {
    const required = requiredDocuments(args.context);
    if (args.acceptedDocuments?.length) {
      this.assertMatchesCurrent(required, args.acceptedDocuments);
    }

    const rows: NewUserConsent[] = required.map((doc) => ({
      userId: args.userId,
      documentCode: doc.code,
      documentVersion: doc.version,
      documentTitle: doc.title,
      context: args.context,
      ip: args.meta?.ip ?? null,
      userAgent: args.meta?.userAgent ?? null,
    }));

    const exec = args.exec ?? this.db;
    return exec.insert(userConsents).values(rows).returning();
  }

  /**
   * Every acceptance this user has made, newest first, plus what is still
   * outstanding. `pending` is non-empty for accounts created before consent
   * was collected, and after a document is republished at a new version.
   */
  async status(userId: string) {
    const accepted = await this.db
      .select()
      .from(userConsents)
      .where(eq(userConsents.userId, userId))
      .orderBy(desc(userConsents.acceptedAt));

    const acceptedCurrent = new Set(
      accepted
        .filter(
          (c) =>
            LEGAL_DOCUMENTS[c.documentCode as keyof typeof LEGAL_DOCUMENTS]
              ?.version === c.documentVersion,
        )
        .map((c) => c.documentCode),
    );

    return {
      documents: this.documents(),
      accepted,
      pending: requiredDocuments('registration').filter(
        (doc) => !acceptedCurrent.has(doc.code),
      ),
    };
  }

  /**
   * Has this user accepted, in this context, every document the context
   * requires at its current version? Billing asks before creating a payment.
   */
  async hasAccepted(userId: string, context: ConsentContext): Promise<boolean> {
    const rows = await this.db
      .select({
        code: userConsents.documentCode,
        version: userConsents.documentVersion,
      })
      .from(userConsents)
      .where(
        and(eq(userConsents.userId, userId), eq(userConsents.context, context)),
      );
    return requiredDocuments(context).every((doc) =>
      rows.some((r) => r.code === doc.code && r.version === doc.version),
    );
  }

  /** Consents of one user — for the admin panel's user card. */
  consentsOf(userId: string): Promise<UserConsentRow[]> {
    return this.db
      .select()
      .from(userConsents)
      .where(eq(userConsents.userId, userId))
      .orderBy(desc(userConsents.acceptedAt));
  }

  private assertMatchesCurrent(
    required: LegalDocument[],
    echoed: AcceptedDocumentDto[],
  ): void {
    const sent = new Map(echoed.map((d) => [d.code, d.version]));
    const stale = required.filter(
      (doc) => sent.has(doc.code) && sent.get(doc.code) !== doc.version,
    );
    if (stale.length > 0) {
      throw new ConflictException(
        `These documents have been updated — please re-read and accept them: ${stale
          .map((d) => `${d.title} (${d.version})`)
          .join(', ')}`,
      );
    }
  }
}
