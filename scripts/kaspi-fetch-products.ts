/**
 * Kaspi internal cabinet API — product list probe.
 *
 * Standalone (no Nest/DB). Calls the seller-cabinet BFF endpoint
 *   GET https://mc.shop.kaspi.kz/bff/offer-view/list?m=<merchant>&p=<page>&l=<limit>&a=true
 * using the captured browser SESSION COOKIE (mc-sid / mc-session), and dumps
 * the full JSON so we can see the real object shape (price/stock/stores).
 *
 * Cookie is read from a gitignored file (default tmp/kaspi/cookie.txt) so the
 * secret never lands in source or argv.
 *
 * Usage:
 *   bun run scripts/kaspi-fetch-products.ts [--m=12345678] [--cookie-file=tmp/kaspi/cookie.txt]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function arg(name: string, fallback?: string): string | undefined {
  const p = `--${name}=`;
  return process.argv.find((a) => a.startsWith(p))?.slice(p.length) ?? fallback;
}

const MERCHANT = arg('m', process.env.KASPI_MERCHANT ?? '12345678')!;
const COOKIE_FILE = arg('cookie-file', 'tmp/kaspi/cookie.txt')!;
const HOST = 'https://mc.shop.kaspi.kz';
const OUT_DIR = join(process.cwd(), 'tmp', 'kaspi');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadCookie(): Promise<string> {
  try {
    const c = (await readFile(join(process.cwd(), COOKIE_FILE), 'utf8')).trim();
    if (!c) throw new Error('empty');
    return c;
  } catch {
    console.error(
      `No cookie at ${COOKIE_FILE}. Put the captured Cookie header value there.`,
    );
    process.exit(1);
  }
}

async function getList(cookie: string, page: number, limit: number) {
  const url = `${HOST}/bff/offer-view/list?m=${MERCHANT}&p=${page}&l=${limit}&a=true`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://kaspi.kz',
      Referer: 'https://kaspi.kz/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15',
      'X-Auth-Version': '3',
      Cookie: cookie,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { url, status: res.status, text, json };
}

function describe(obj: unknown, indent = ''): string {
  if (obj === null) return 'null';
  if (Array.isArray(obj)) return `Array(${obj.length})`;
  if (typeof obj !== 'object') return `${typeof obj}`;
  return Object.entries(obj as Record<string, unknown>)
    .map(([k, v]) => {
      const t = Array.isArray(v)
        ? `Array(${v.length})`
        : v === null
          ? 'null'
          : typeof v === 'object'
            ? 'object'
            : `${typeof v} = ${JSON.stringify(v)}`;
      return `${indent}  ${k}: ${t}`;
    })
    .join('\n');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const cookie = await loadCookie();
  console.log(`merchant=${MERCHANT}  host=${HOST}\n`);

  // Probe page 0 and page 1 at limit 10, plus a large-limit page.
  const probes: Array<{ name: string; page: number; limit: number }> = [
    { name: 'list-p0-l10', page: 0, limit: 10 },
    { name: 'list-p1-l10', page: 1, limit: 10 },
    { name: 'list-p0-l100', page: 0, limit: 100 },
  ];

  let firstFull: unknown;
  for (const { name, page, limit } of probes) {
    const { url, status, text, json } = await getList(cookie, page, limit);
    const j = json as Record<string, unknown> | undefined;
    const data = j && Array.isArray(j.data) ? (j.data as unknown[]) : undefined;
    await writeFile(
      join(OUT_DIR, `offer-${name}.json`),
      json !== undefined ? JSON.stringify(json, null, 2) : text,
      'utf8',
    );
    console.log(
      `${name.padEnd(14)} ${status}  ${url}\n` +
        `   total=${j?.total ?? '?'}  data=${data ? data.length : 'n/a'}  bytes=${text.length}`,
    );
    if (!firstFull && data && data.length) firstFull = data[0];
    await sleep(500);
  }

  console.log(`\nFull responses written to ${OUT_DIR}`);
  if (firstFull) {
    console.log('\n=== FIRST OFFER — FULL FIELD SHAPE ===');
    console.log(describe(firstFull));
    console.log('\n=== FIRST OFFER — RAW ===');
    console.log(JSON.stringify(firstFull, null, 2));
  } else {
    console.log('\nNo offers parsed — inspect the dumped files / status codes.');
  }
}

main().catch((e) => {
  console.error('crashed:', e);
  process.exit(1);
});
