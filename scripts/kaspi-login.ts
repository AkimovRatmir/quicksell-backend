/**
 * Trace the Kaspi merchant login chain end-to-end:
 *   POST idmc.shop.kaspi.kz/api/p/login  ->  SSO  ->  mc-sid/mc-session
 *
 * Manual cookie jar + manual redirect following so we can see exactly which
 * hop sets which cookie. Reads creds from tmp/kaspi/login.json (gitignored).
 *
 * Usage: bun run scripts/kaspi-login.ts
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const { email, password } = JSON.parse(
  await readFile(join(process.cwd(), 'tmp/kaspi/login.json'), 'utf8'),
) as { email: string; password: string };

/** name -> value cookie jar. */
const jar = new Map<string, string>();

function ingest(res: Response) {
  // Bun/undici expose getSetCookie(); fall back to raw header.
  const setCookies: string[] =
    (res.headers as any).getSetCookie?.() ??
    (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (v === '' || v === 'deleted') jar.delete(k);
      else jar.set(k, v);
    }
  }
}

const cookieHeader = () =>
  [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15';

async function hop(
  label: string,
  url: string,
  init: RequestInit & { maxRedirects?: number } = {},
) {
  let current = url;
  const max = init.maxRedirects ?? 6;
  for (let i = 0; i <= max; i++) {
    const res = await fetch(current, {
      ...init,
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        ...(init.headers ?? {}),
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    ingest(res);
    const loc = res.headers.get('location');
    console.log(
      `[${label}] ${init.method ?? 'GET'} ${current} -> ${res.status}` +
        (loc ? `  ->Location: ${loc}` : ''),
    );
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      init = { ...init, method: 'GET', body: undefined }; // redirects are GET
      continue;
    }
    const ct = res.headers.get('content-type') ?? '';
    const body = await res.text();
    if (ct.includes('json')) {
      console.log(`   body: ${body.slice(0, 300)}`);
    } else {
      console.log(`   (${ct || 'no ct'}, ${body.length}B)`);
    }
    return { res, body };
  }
  console.log(`[${label}] exceeded ${max} redirects`);
  return null;
}

console.log('== 1. POST idmc /api/p/login ==');
const login = await hop('login', 'https://idmc.shop.kaspi.kz/api/p/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Origin: 'https://idmc.shop.kaspi.kz',
    Referer: 'https://idmc.shop.kaspi.kz/login',
  },
  body: JSON.stringify({ _u: email, _p: password, _r_d: false }),
});
const redirectUrl =
  (login && JSON.parse(login.body)?.redirectUrl) || '/';
console.log('jar after login:', [...jar.keys()].join(', ') || '(empty)');

console.log(`\n== 2. follow redirectUrl from idmc (SSO exchange) ==`);
await hop(
  'sso',
  new URL(redirectUrl, 'https://idmc.shop.kaspi.kz/').toString(),
  { headers: { Referer: 'https://idmc.shop.kaspi.kz/login' }, maxRedirects: 10 },
);
console.log('jar:', [...jar.keys()].join(', ') || '(empty)');

console.log('\n== 3. hit mc.shop.kaspi.kz/s/m (needs mc-session) ==');
const m = await hop('s/m', 'https://mc.shop.kaspi.kz/s/m', {
  headers: {
    Origin: 'https://kaspi.kz',
    Referer: 'https://kaspi.kz/',
    'X-Auth-Version': '3',
  },
});

console.log('\n=== FINAL JAR ===');
for (const [k, v] of jar)
  console.log(`  ${k} = ${v.slice(0, 40)}${v.length > 40 ? '…' : ''}`);

const haveSession = jar.has('mc-session') && jar.has('mc-sid');
console.log(
  `\nmc-sid present: ${jar.has('mc-sid')} | mc-session present: ${jar.has('mc-session')}`,
);

if (haveSession && m?.res.status === 200) {
  try {
    const uid = JSON.parse(m.body).merchants?.[0]?.uid;
    console.log(`SUCCESS — derived merchant uid via headless login: ${uid}`);
  } catch {
    console.log('s/m returned 200 but body not parseable');
  }
} else {
  console.log(
    'Did NOT obtain mc-session via this path — inspect the hop log above for the SSO exchange step.',
  );
}
