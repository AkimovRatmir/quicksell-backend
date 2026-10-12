/**
 * Client for Kaspi's OFFICIAL Shop API v2 orders endpoints (X-Auth-Token auth).
 *
 *   GET https://kaspi.kz/shop/api/v2/orders?page[number]=&page[size]=
 *       &filter[orders][state]=ARCHIVE
 *       &filter[orders][creationDate][$ge]=<epoch-ms>&filter[orders][creationDate][$le]=<epoch-ms>
 *   GET https://kaspi.kz/shop/api/v2/orders/{id}/entries
 *
 * JSON:API — must Accept `application/vnd.api+json`. `creationDate` filters are
 * REQUIRED and Kaspi caps the window per request (we chunk to <= 14 days).
 *
 * Kaspi's edge intermittently STALLS (accepts the TLS connection, then never
 * answers → a client timeout). This is the same failure seen on the product
 * cabinet API, so every request is retried a few times before giving up.
 */
import { KaspiAuthError } from './kaspi.client';

const BASE = 'https://kaspi.kz/shop/api/v2';
const PAGE_SIZE = 100;
/** Kaspi rejects creationDate windows wider than ~14 days. */
export const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 45_000;
const RETRIES = 4;

export interface KaspiOrderAttributes {
  code: string;
  state: string;
  status: string;
  totalPrice?: number;
  deliveryCost?: number;
  deliveryCostForSeller?: number;
  paymentMode?: string;
  deliveryMode?: string;
  isKaspiDelivery?: boolean;
  preOrder?: boolean;
  signatureRequired?: boolean;
  assembled?: boolean;
  pickupPointId?: string | null;
  creationDate?: number;
  approvedByBankDate?: number;
  completionDate?: number;
  plannedDeliveryDate?: number | null;
  cancellationReason?: string | null;
  creditTerm?: number | null;
  customer?: {
    name?: string;
    firstName?: string;
    lastName?: string;
    cellPhone?: string;
  } | null;
  deliveryAddress?: { town?: string | null } | null;
  [k: string]: unknown;
}

export interface KaspiOrder {
  id: string; // opaque Kaspi id used to fetch entries
  attributes: KaspiOrderAttributes;
}

export interface KaspiOrderEntryAttributes {
  entryNumber?: number;
  quantity?: number;
  basePrice?: number;
  totalPrice?: number;
  unitType?: string;
  barCode?: string;
  offer?: { code?: string; name?: string } | null;
  category?: { code?: string; title?: string } | null;
  [k: string]: unknown;
}

interface JsonApiListResponse<A> {
  data?: Array<{ id: string; type: string; attributes: A }>;
  meta?: { totalCount?: number; pageCount?: number };
  errors?: Array<{ title?: string; detail?: string }>;
}

function headers(token: string): Record<string, string> {
  return {
    'X-Auth-Token': token,
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    // Kaspi's bot edge is friendlier to a browser-ish UA.
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15',
  };
}

/** GET with retries for Kaspi's intermittent stalls. Auth errors don't retry. */
async function getJson<T>(url: string, token: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: headers(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // Timeout / network stall → retry.
      lastErr = e;
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw new KaspiAuthError(
        `Kaspi rejected the API token (HTTP ${res.status}). Check the seller's X-Auth-Token.`,
      );
    }

    const body = await res.text();
    if (!res.ok) {
      throw new Error(
        `Kaspi orders API HTTP ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    let json: T & { errors?: Array<{ title?: string; detail?: string }> };
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(
        `Kaspi orders API returned non-JSON: ${body.slice(0, 200)}`,
      );
    }
    if (json.errors?.length) {
      const msg = json.errors
        .map((e) => e.detail ?? e.title ?? 'unknown')
        .join('; ');
      throw new Error(`Kaspi orders API error: ${msg}`);
    }
    return json;
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`Kaspi orders API failed after ${RETRIES} attempts`);
}

function ordersUrl(
  state: string,
  geMs: number,
  leMs: number,
  page: number,
  size: number,
): string {
  const p = new URLSearchParams();
  p.set('page[number]', String(page));
  p.set('page[size]', String(size));
  p.set('filter[orders][state]', state);
  p.set('filter[orders][creationDate][$ge]', String(geMs));
  p.set('filter[orders][creationDate][$le]', String(leMs));
  return `${BASE}/orders?${p.toString()}`;
}

/** All orders in a single <=14-day window for one state, paging through. */
async function fetchOrdersWindow(
  token: string,
  state: string,
  geMs: number,
  leMs: number,
): Promise<KaspiOrder[]> {
  const out: KaspiOrder[] = [];
  const first = await getJson<JsonApiListResponse<KaspiOrderAttributes>>(
    ordersUrl(state, geMs, leMs, 0, PAGE_SIZE),
    token,
  );
  for (const d of first.data ?? []) {
    out.push({ id: d.id, attributes: d.attributes });
  }
  const total = first.meta?.totalCount ?? out.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  for (let page = 1; page < pages; page++) {
    const res = await getJson<JsonApiListResponse<KaspiOrderAttributes>>(
      ordersUrl(state, geMs, leMs, page, PAGE_SIZE),
      token,
    );
    const data = res.data ?? [];
    if (data.length === 0) break;
    for (const d of data) out.push({ id: d.id, attributes: d.attributes });
  }
  return out;
}

/**
 * Every order in [geMs, leMs] for `state`, chunking the range into <=14-day
 * windows (Kaspi's per-request cap).
 */
export async function fetchOrders(
  token: string,
  geMs: number,
  leMs: number,
  state = 'ARCHIVE',
): Promise<KaspiOrder[]> {
  const all: KaspiOrder[] = [];
  let windowStart = geMs;
  while (windowStart <= leMs) {
    const windowEnd = Math.min(windowStart + MAX_WINDOW_MS - 1, leMs);
    const chunk = await fetchOrdersWindow(token, state, windowStart, windowEnd);
    all.push(...chunk);
    windowStart = windowEnd + 1;
  }
  return all;
}

/** Non-archive order states — orders still in progress that need action. */
export const ACTIVE_ORDER_STATES = [
  'NEW',
  'SIGN_REQUIRED',
  'PICKUP',
  'DELIVERY',
  'KASPI_DELIVERY',
] as const;

/**
 * Fetch all currently-active (non-archive) orders, live. Queries each active
 * state over the last `sinceDays` days (Kaspi caps the window at 14) and
 * returns the combined list plus a per-state count. Not stored — active orders
 * change state constantly, so this is always fetched fresh.
 */
export async function fetchActiveOrders(
  token: string,
  sinceDays = 14,
): Promise<{ byState: Record<string, number>; orders: KaspiOrder[] }> {
  const now = Date.now();
  const ge = now - Math.min(sinceDays, 14) * 24 * 60 * 60 * 1000 + 1;
  const byState: Record<string, number> = {};
  const orders: KaspiOrder[] = [];
  for (const state of ACTIVE_ORDER_STATES) {
    const chunk = await fetchOrders(token, ge, now, state);
    byState[state] = chunk.length;
    orders.push(...chunk);
  }
  return { byState, orders };
}

/** Line items for one order. */
export async function fetchOrderEntries(
  token: string,
  orderId: string,
): Promise<KaspiOrderEntryAttributes[]> {
  const res = await getJson<JsonApiListResponse<KaspiOrderEntryAttributes>>(
    `${BASE}/orders/${encodeURIComponent(orderId)}/entries`,
    token,
  );
  return (res.data ?? []).map((d) => d.attributes);
}
