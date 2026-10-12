/**
 * Run `worker` over every item, at most `limit` at a time.
 *
 * Kaspi syncs are network-bound: a seller's sync spends nearly all its time
 * waiting on Kaspi, so running them strictly one after another leaves both the
 * CPU and the connection pool idle. The cap is what keeps that from turning
 * into a burst of requests at Kaspi (and a pile of open DB transactions).
 *
 * Items are handed out in order, but finish whenever they finish. A worker that
 * throws rejects the whole run, so callers that must not stop on one bad item
 * (the cron loops) catch inside their own worker.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        await worker(items[next++]);
      }
    },
  );
  await Promise.all(lanes);
}

/**
 * Same bounded concurrency, but keeps each item's result in its original
 * position — used to fetch a batch of order line items in parallel and then
 * write them in the order Kaspi returned them.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i]);
      }
    },
  );
  await Promise.all(lanes);
  return out;
}
