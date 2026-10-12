import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Raw analytics events. One row per ingested event.
 *
 * - `eventTimestamp` is the client-supplied time the event occurred.
 * - `ingestedAt` is the server receipt time (defaults to now()).
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventName: text('event_name').notNull(),
    distinctId: text('distinct_id'), // resolved/known user id
    anonymousId: text('anonymous_id'), // pre-identify device id
    sessionId: text('session_id'),
    properties: jsonb('properties').notNull().default(sql`'{}'::jsonb`),
    context: jsonb('context').notNull().default(sql`'{}'::jsonb`),
    eventTimestamp: timestamp('event_timestamp', { withTimezone: true })
      .notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_events_name_time').on(t.eventName, t.eventTimestamp),
    index('idx_events_time').on(t.eventTimestamp),
    index('idx_events_distinct').on(t.distinctId),
    index('idx_events_session').on(t.sessionId),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
