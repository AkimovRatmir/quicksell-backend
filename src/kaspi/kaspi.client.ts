/**
 * Thin client for Kaspi's internal seller-cabinet BFF.
 *
 * Endpoint (undocumented, session-cookie auth):
 *   GET https://mc.shop.kaspi.kz/bff/offer-view/list?m=<merchant>&p=<page>&l=<limit>&a=true
 * Pagination is 0-indexed; `l` (page size) works up to ~100.
 */
const HOST = 'https://mc.shop.kaspi.kz';
const MAX_PAGE_SIZE = 100;

/** Subset of the offer object we rely on; extra fields pass through in `raw`. */
export interface KaspiOffer {
  offerId: string | null;
  sku: string;
  model?: string;
  title?: string;
  brand?: string | null;
  brandName?: string | null;
  brandCode?: string | null;
  masterCategory?: string | null;
  minPrice?: number;
  maxPrice?: number;
  available?: boolean;
  availabilities?: Array<{
    available?: string;
    storeId?: string;
    stockCount?: number;
    preOrder?: number;
  }>;
  images?: string[];
  updatedAt?: string | null;
  [k: string]: unknown;
}

interface OfferListResponse {
  data: KaspiOffer[];
  total: number;
}

export class KaspiAuthError extends Error {}

function headers(cookie: string): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://kaspi.kz',
    Referer: 'https://kaspi.kz/',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15',
    'X-Auth-Version': '3',
    Cookie: cookie,
  };
}

/**
 * Resolves the logged-in merchant's UID from the session cookie alone.
 * `GET /s/m` → { merchants: [{ uid, roles }] }.
 */
export async function fetchMerchantUid(cookie: string): Promise<string> {
  const res = await fetch(`${HOST}/s/m`, {
    method: 'GET',
    headers: headers(cookie),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new KaspiAuthError(
      `Kaspi rejected the session resolving merchant (HTTP ${res.status}) — cookie likely expired.`,
    );
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Kaspi /s/m HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  let json: { merchants?: Array<{ uid?: string }> };
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('Kaspi /s/m returned non-JSON (likely an auth redirect)');
  }
  const merchants = json.merchants ?? [];
  if (merchants.length === 0 || !merchants[0].uid) {
    throw new Error('Kaspi /s/m returned no merchant for this session');
  }
  if (merchants.length > 1) {
    // Multi-merchant accounts: caller may need to pass an explicit UID.
    throw new MultipleMerchantsError(
      merchants.map((m) => m.uid!).filter(Boolean),
    );
  }
  return merchants[0].uid!;
}

export class MultipleMerchantsError extends Error {
  constructor(public readonly uids: string[]) {
    super(
      `This Kaspi account has multiple merchants (${uids.join(
        ', ',
      )}). Pass kaspiMerchantUid explicitly.`,
    );
  }
}

export async function fetchOfferPage(
  cookie: string,
  merchantUid: string,
  page: number,
  limit: number,
): Promise<OfferListResponse> {
  const url = `${HOST}/bff/offer-view/list?m=${encodeURIComponent(
    merchantUid,
  )}&p=${page}&l=${Math.min(limit, MAX_PAGE_SIZE)}&a=true`;

  const res = await fetch(url, {
    method: 'GET',
    headers: headers(cookie),
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new KaspiAuthError(
      `Kaspi rejected the session (HTTP ${res.status}). The seller cookie is likely expired — recapture it.`,
    );
  }
  const body = await res.text();
  if (!res.ok) {
    // Kaspi sometimes signals an expired cookie with a 500 whose body says
    // "Authorization header is required" instead of a clean 401. Treat it as
    // an auth error so the caller re-logins from stored credentials.
    if (/authorization header is required/i.test(body)) {
      throw new KaspiAuthError(
        `Kaspi rejected the session (HTTP ${res.status}: authorization required). Cookie likely expired — refreshing.`,
      );
    }
    throw new Error(`Kaspi offer-view/list HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  let json: OfferListResponse;
  try {
    json = JSON.parse(body) as OfferListResponse;
  } catch {
    throw new Error(
      `Kaspi returned non-JSON (likely an auth/login redirect): ${body.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(json.data)) {
    throw new Error('Kaspi response missing data[] array');
  }
  return json;
}

/** Fetch every offer for a merchant, paging through at MAX_PAGE_SIZE. */
export async function fetchAllOffers(
  cookie: string,
  merchantUid: string,
): Promise<{ offers: KaspiOffer[]; total: number }> {
  const first = await fetchOfferPage(cookie, merchantUid, 0, MAX_PAGE_SIZE);
  const total = first.total ?? first.data.length;
  const offers = [...first.data];

  const pages = Math.ceil(total / MAX_PAGE_SIZE);
  for (let p = 1; p < pages; p++) {
    const page = await fetchOfferPage(cookie, merchantUid, p, MAX_PAGE_SIZE);
    offers.push(...page.data);
    if (page.data.length === 0) break; // safety against bad totals
  }
  return { offers, total };
}
