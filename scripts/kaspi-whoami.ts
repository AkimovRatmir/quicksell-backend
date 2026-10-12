/**
 * Find the Kaspi BFF endpoint that returns the logged-in merchant's UID
 * from just the session cookie (so we can auto-derive kaspiMerchantUid).
 *
 * Usage: bun run scripts/kaspi-whoami.ts [--cookie-file=tmp/kaspi/cookie.txt]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const COOKIE_FILE =
  process.argv.find((a) => a.startsWith('--cookie-file='))?.slice(14) ??
  'tmp/kaspi/cookie.txt';
const OUT = join(process.cwd(), 'tmp', 'kaspi');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const headers = {
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://kaspi.kz',
  Referer: 'https://kaspi.kz/',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15',
  'X-Auth-Version': '3',
};

// Candidate "who am I / current merchant" endpoints (Kaspi BFF naming guesses).
const candidates = [
  'https://mc.shop.kaspi.kz/bff/profile',
  'https://mc.shop.kaspi.kz/bff/account',
  'https://mc.shop.kaspi.kz/bff/merchant',
  'https://mc.shop.kaspi.kz/bff/merchants',
  'https://mc.shop.kaspi.kz/bff/user',
  'https://mc.shop.kaspi.kz/bff/context',
  'https://mc.shop.kaspi.kz/bff/menu',
  'https://mc.shop.kaspi.kz/bff/settings',
  'https://mc.shop.kaspi.kz/bff/whoami',
  'https://mc.shop.kaspi.kz/bff/offer-view/filters',
  'https://mc.shop.kaspi.kz/bff/offer-view/settings',
  'https://idmc.shop.kaspi.kz/api/p/profile',
];

async function main() {
  const cookie = (
    await readFile(join(process.cwd(), COOKIE_FILE), 'utf8')
  ).trim();
  await mkdir(OUT, { recursive: true });

  for (const url of candidates) {
    let line = `${url}\n  `;
    try {
      const res = await fetch(url, {
        headers: { ...headers, Cookie: cookie },
        signal: AbortSignal.timeout(15000),
      });
      const ct = res.headers.get('content-type') ?? '';
      const body = await res.text();
      const isJson = ct.includes('json');
      line += `${res.status} ${ct} ${body.length}B`;
      if (isJson && res.ok) {
        const safe = url.replace(/[^a-z0-9]+/gi, '_');
        await writeFile(join(OUT, `whoami${safe}.json`), body, 'utf8');
        const m = body.match(
          /"(merchant(Uid|Id)?|uid|id)"\s*:\s*"?(\d{6,})"?/i,
        );
        if (m) line += `  <-- possible merchant id: ${m[3]}`;
        line += `\n  preview: ${body.slice(0, 200)}`;
      }
    } catch (e) {
      line += `ERR ${(e as Error).message}`;
    }
    console.log(line + '\n');
    await sleep(400);
  }
  console.log(`JSON responses (if any) saved under ${OUT}`);
}

main().catch((e) => {
  console.error('crashed:', e);
  process.exit(1);
});
