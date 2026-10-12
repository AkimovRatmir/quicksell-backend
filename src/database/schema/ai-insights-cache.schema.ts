import {
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sellers } from './sellers.schema';

/**
 * Cached AI insight per (seller, period). Generating hits OpenAI (paid + slow),
 * and the same insight is reused across the Dashboard / Finance / Products
 * pages, so we store it and regenerate at most once a day (or on an explicit
 * Pro "refresh"). One row per (seller, period).
 */
export const aiInsightsCache = pgTable(
  'ai_insights_cache',
  {
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => sellers.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    model: text('model').notNull(),
    insights: jsonb('insights').notNull(),
    basedOn: jsonb('based_on').notNull().default({}),
    generatedAt: timestamp('generated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sellerId, t.period] })],
);

export type AiInsightsCacheRow = typeof aiInsightsCache.$inferSelect;
export type NewAiInsightsCache = typeof aiInsightsCache.$inferInsert;
