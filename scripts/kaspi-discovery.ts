/**
 * Kaspi product discovery spike.
 *
 * Standalone — no NestJS, no DB. Probes the official Kaspi Shop API with a
 * per-seller X-Auth-Token and dumps every response to ./tmp/kaspi/ so we can
 * see what the seller's product/offer data actually looks like.
 *
 * Usage:
 *   bun run scripts/kaspi-discovery.ts --token='<token>' [--base='https://kaspi.kz/shop/api']
 *   KASPI_API_TOKEN=<token> bun run scripts/kaspi-discovery.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const TOKEN = argValue('token') ?? process.env.KASPI_API_TOKEN;
const BASE = (
  argValue('base') ??
  process.env.KASPI_BASE_URL ??
  'https://kaspi.kz/shop/api'
).replace(/\/+$/, '');

if (!TOKEN) {
  console.error(
    'No token. Pass --token=<value> or set KASPI_API_TOKEN.\n' +
      "Example: bun run scripts/kaspi-discovery.ts --token='abc...'",
  );
  process.exit(1);
}

const OUT_DIR = join(process.cwd(), 'tmp', 'kaspi');

// Kaspi's v2 API negotiates on Accept and rejects application/json with 406:
// "Acceptable representations: [application/vnd.api+json;charset=UTF-8]".
const HEADERS: Record<string, string> = {
  'X-Auth-Token': TOKEN,
  'Content-Type': 'application/vnd.api+json',
  Accept: 'application/vnd.api+json',
  'User-Agent': 'quickAnalytics-discovery/0.1',
};

type Summary = {
  name: string;
  status: number | string;
  contentType: string;
  bytes: number;
  note: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(
  name: string,
  method: string,
  url: string,
): Promise<{ summary: Summary; json: unknown }> {
  let status: number | string = 'ERR';
  let contentType = '';
  let body = '';
  let json: unknown = undefined;
  let note = '';

  try {
    const res = await fetch(url, {
      method,
      headers: HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    status = res.status;
    contentType = res.headers.get('content-type') ?? '';
    body = await res.text();

    if (contentType.includes('json')) {
      try {
        json = JSON.parse(body);
        note = 'json parsed';
      } catch {
        note = 'json content-type but parse failed';
      }
    } else if (/<html|<!doctype/i.test(body.slice(0, 200))) {
      note = 'HTML body (likely login/redirect — wrong base or auth)';
    } else {
      note = 'non-json body';
    }
  } catch (e) {
    note = `request failed: ${(e as Error).message}`;
  }

  const fileBody = json !== undefined ? JSON.stringify(json, null, 2) : body;
  await writeFile(join(OUT_DIR, `${name}.json`), fileBody || note, 'utf8');

  return {
    summary: {
      name,
      status,
      contentType: contentType || '-',
      bytes: body.length,
      note,
    },
    json,
  };
}

function inventory(json: unknown): string {
  if (!json || typeof json !== 'object') return '(no JSON object)';
  const j = json as Record<string, unknown>;
  const data = j.data;
  const lines: string[] = [];

  if (j.meta) lines.push(`meta: ${JSON.stringify(j.meta)}`);
  if (j.errors) lines.push(`errors: ${JSON.stringify(j.errors).slice(0, 500)}`);

  if (Array.isArray(data)) {
    lines.push(`data: array(${data.length})`);
    const first = data[0];
    if (first && typeof first === 'object') {
      lines.push(
        `first item keys: ${Object.keys(first as object).join(', ')}`,
      );
      const attrs = (first as Record<string, unknown>).attributes;
      if (attrs && typeof attrs === 'object') {
        lines.push(
          `first attributes keys: ${Object.keys(attrs as object).join(', ')}`,
        );
      }
      lines.push(
        `first item:\n${JSON.stringify(first, null, 2).slice(0, 1500)}`,
      );
    }
  } else if (data && typeof data === 'object') {
    lines.push(`data: object, keys: ${Object.keys(data as object).join(', ')}`);
  }
  return lines.join('\n');
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Kaspi discovery — base=${BASE}`);
  console.log(`token: ${TOKEN!.slice(0, 4)}…${TOKEN!.slice(-4)}\n`);

  const probes: Array<[string, string, string]> = [
    ['01-products-schema', 'GET', `${BASE}/products/import/schema`],
    [
      '02-products-page0-size20',
      'GET',
      `${BASE}/products?page[number]=0&page[size]=20`,
    ],
    [
      '03-v2-products-page0',
      'GET',
      `${BASE}/v2/products?page[number]=0&page[size]=20`,
    ],
    [
      '04-orders-page0-size1',
      'GET',
      `${BASE}/v2/orders?page[number]=0&page[size]=1&filter[orders][state]=NEW`,
    ],
    [
      '05-orders-archive',
      'GET',
      `${BASE}/v2/orders?page[number]=0&page[size]=1&filter[orders][state]=ARCHIVE`,
    ],
  ];

  const summaries: Summary[] = [];
  let productsJson: unknown;

  for (const [name, method, url] of probes) {
    process.stdout.write(`→ ${name} ${method} ${url}\n`);
    const { summary, json } = await probe(name, method, url);
    summaries.push(summary);
    if (name.startsWith('02-products')) productsJson = json;
    await sleep(500);
  }

  // If the page-0 products probe returned paginated data, confirm page 1.
  const p2 = summaries.find((s) => s.name === '02-products-page0-size20');
  if (
    p2 &&
    p2.status === 200 &&
    productsJson &&
    Array.isArray((productsJson as Record<string, unknown>).data) &&
    ((productsJson as Record<string, unknown>).data as unknown[]).length > 0
  ) {
    process.stdout.write('→ 05-products-page1-size20 (pagination check)\n');
    const { summary } = await probe(
      '05-products-page1-size20',
      'GET',
      `${BASE}/products?page[number]=1&page[size]=20`,
    );
    summaries.push(summary);
  }

  console.log('\n=== SUMMARY ===');
  for (const s of summaries) {
    console.log(
      `${s.name.padEnd(28)} ${String(s.status).padEnd(6)} ${s.contentType.padEnd(
        32,
      )} ${String(s.bytes).padStart(7)}B  ${s.note}`,
    );
  }

  console.log(`\nFull responses written to: ${OUT_DIR}`);
  console.log('\n=== PRODUCTS PROBE INVENTORY (02) ===');
  console.log(inventory(productsJson));
}

main().catch((e) => {
  console.error('discovery crashed:', e);
  process.exit(1);
});
