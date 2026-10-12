import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.schema';

/**
 * One acceptance of one legal document by one user — the audit trail behind
 * the signup checkbox («Я принимаю условия Публичной оферты …»).
 *
 * Append-only: rows are never updated or deleted. Accepting a new version of a
 * document, or accepting again in another context (paying for a subscription),
 * adds another row. The question a consent log has to answer is "what exactly
 * did this user agree to, and when" — rewriting a row would destroy that.
 *
 * `documentTitle` is a snapshot of the title as it was shown at acceptance
 * time: the registry in src/legal/legal-documents.ts can be reworded later,
 * and this record must still describe what the user actually agreed to.
 */
export const userConsents = pgTable(
  'user_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Document key from the registry: 'oferta' | 'policy' | 'payment'. */
    documentCode: text('document_code').notNull(),
    /** Version as published at acceptance time, e.g. '1.0'. */
    documentVersion: text('document_version').notNull(),
    /** Title as shown to the user, kept so the row reads on its own. */
    documentTitle: text('document_title').notNull(),
    /** Where the checkbox was ticked: 'registration' | 'subscription'. */
    context: text('context').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Request metadata — evidence of who ticked the box. NULL if unknown. */
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('idx_user_consents_user').on(t.userId),
    index('idx_user_consents_document').on(t.documentCode, t.documentVersion),
  ],
);

export type UserConsentRow = typeof userConsents.$inferSelect;
export type NewUserConsent = typeof userConsents.$inferInsert;
