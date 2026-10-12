import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Builds a typed Drizzle client backed by a postgres-js connection pool.
 * `prepare: false` keeps it safe behind a connection pooler (pgbouncer);
 * harmless when connecting directly.
 */
export function makeDb(url: string) {
  const client = postgres(url, { max: 10, prepare: false });
  return drizzle(client, { schema });
}
