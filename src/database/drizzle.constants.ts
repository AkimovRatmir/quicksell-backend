import type { makeDb } from './database.providers';

export const DRIZZLE = Symbol('DRIZZLE_CONNECTION');

export type DrizzleDB = ReturnType<typeof makeDb>;

/** The handle passed to `db.transaction(async (tx) => …)`. */
export type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/**
 * Pool or open transaction. Lets a helper write through a caller's transaction
 * (registration: the user row and its consent rows land together or not at all).
 */
export type DrizzleExecutor = DrizzleDB | DrizzleTx;
