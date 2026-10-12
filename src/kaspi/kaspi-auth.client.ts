/**
 * Headless Kaspi merchant login → mints the cabinet session cookie.
 *
 * Kaspi now enforces email MFA on untrusted devices. The real flow (reversed
 * from idmc's login SPA) is:
 *
 *   1. POST idmc.shop.kaspi.kz/api/p/login {_u,_p,_r_d:true}
 *        → 200 {redirectUrl}   device already trusted  → straight to step 3
 *        → 200 {email}         MFA required, 6-digit code auto-sent to email
 *        → 200 {su:…}          multi-merchant account (not handled yet)
 *   2. POST idmc.shop.kaspi.kz/api/p/login {_m_c:<code>,_r_d:true,_u:<email>}
 *        → 200 {redirectUrl}   (also sets a persistent trusted-device cookie)
 *      (resend the code with POST /api/p/mfa/send)
 *   3. follow redirectUrl → idmc authorize → mc callback
 *        → Set-Cookie mc-sid + mc-session   (the cabinet session)
 *
 * `_r_d` = "remember device". When true, step 2 sets a long-lived device
 * cookie; presenting it on a later step 1 skips MFA entirely. So we persist the
 * WHOLE cookie jar per seller (not just mc-sid/mc-session) and replay it to
 * re-auth silently — MFA is asked once per seller, not every sync.
 */
import { KaspiAuthError } from './kaspi.client';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15';

const LOGIN_URL = 'https://idmc.shop.kaspi.kz/api/p/login';
const OAUTH_KICK_URL = 'https://mc.shop.kaspi.kz/oauth2/authorization/1';

/** Serialized cookie jar (name → value), what we persist for device trust. */
export type CookieJar = Record<string, string>;

/** Result of a login attempt. */
export type LoginResult =
  | {
      /** Device was trusted (or already logged in) — no code needed. */
      status: 'ok';
      /** `mc-sid=…; mc-session=…` header for the cabinet APIs. */
      cabinetCookie: string;
      /** Full jar (incl. trusted-device cookie) to persist for silent re-auth. */
      deviceCookies: CookieJar;
    }
  | {
      /** A 6-digit code was emailed; call submitOtp with `pending`. */
      status: 'mfa_required';
      /** Masked-ish email Kaspi says it sent the code to (for the UI). */
      emailSentTo: string;
      /** Opaque state to hand back to submitOtp / resendOtp. */
      pending: MfaPending;
    };

/** Carries the pre-auth session between beginLogin and submitOtp. */
export interface MfaPending {
  /** Pre-auth jar (holds MS_AUTH_SSO) captured right after the password step. */
  jar: CookieJar;
  /** Login the code was sent for (echoed back on verify as `_u`). */
  email: string;
}

/** Minimal cookie jar (name → value), no domain scoping needed. */
class Jar {
  private m = new Map<string, string>();

  static from(obj: CookieJar | undefined | null): Jar {
    const j = new Jar();
    for (const [k, v] of Object.entries(obj ?? {})) j.m.set(k, v);
    return j;
  }

  ingest(res: Response) {
    const setCookies: string[] =
      (res.headers as unknown as { getSetCookie?: () => string[] })
        .getSetCookie?.() ??
      (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || v === '""' || v === 'deleted') this.m.delete(k);
      else this.m.set(k, v);
    }
  }

  header() {
    return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  has(k: string) {
    return this.m.has(k);
  }
  pick(keys: string[]) {
    return keys
      .filter((k) => this.m.has(k))
      .map((k) => `${k}=${this.m.get(k)}`)
      .join('; ');
  }
  toJSON(): CookieJar {
    return Object.fromEntries(this.m);
  }
}

async function follow(
  jar: Jar,
  url: string,
  init: RequestInit = {},
  maxRedirects = 12,
): Promise<Response> {
  let current = url;
  let opts = init;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current, {
      ...opts,
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/json,*/*',
        ...(opts.headers ?? {}),
        ...(jar.header() ? { Cookie: jar.header() } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    jar.ingest(res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      opts = { headers: init.headers }; // redirects follow as GET
      continue;
    }
    return res;
  }
  throw new Error(`Kaspi login exceeded ${maxRedirects} redirects`);
}

/** POST a JSON body to the login endpoint carrying the jar's cookies. */
async function postLogin(jar: Jar, body: unknown): Promise<Response> {
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://idmc.shop.kaspi.kz',
      Referer: 'https://idmc.shop.kaspi.kz/login',
      'User-Agent': UA,
      ...(jar.header() ? { Cookie: jar.header() } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  jar.ingest(res);
  return res;
}

/** Best-effort error code Kaspi returns in the body (e.g. SECURITY_CODE_INVALID). */
function errorCode(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const k of ['errorCode', 'code', 'error']) {
      if (typeof d[k] === 'string') return d[k] as string;
    }
  }
  return undefined;
}

/** Seconds Kaspi asks us to wait, from `errorData.breakTimeSeconds`, if present. */
function breakTimeSeconds(data: unknown): number | undefined {
  const ed = (data as { errorData?: { breakTimeSeconds?: unknown } })?.errorData;
  return typeof ed?.breakTimeSeconds === 'number' ? ed.breakTimeSeconds : undefined;
}

/** A "wait N seconds" phrase, or empty if Kaspi didn't say. */
function waitPhrase(data: unknown): string {
  const s = breakTimeSeconds(data);
  return s ? ` Try again in ~${s}s.` : '';
}

/**
 * Finish an authenticated login → cabinet cookie.
 *
 * Note we IGNORE the login response's `redirectUrl` (it's just the SPA landing,
 * e.g. "/"). What mints mc-sid/mc-session is hitting the mc OAuth kick with the
 * now-authenticated idmc session — the same exchange the browser's cabinet does
 * on load.
 */
async function completeSso(jar: Jar): Promise<LoginResult> {
  await follow(jar, OAUTH_KICK_URL);
  if (!jar.has('mc-sid') || !jar.has('mc-session')) {
    throw new KaspiAuthError(
      'Kaspi SSO exchange did not yield a cabinet session (mc-sid/mc-session).',
    );
  }
  return {
    status: 'ok',
    cabinetCookie: jar.pick(['mc-sid', 'mc-session']),
    deviceCookies: jar.toJSON(),
  };
}

/**
 * Step 1: submit credentials. Replays `deviceCookies` (if any) so a trusted
 * device skips MFA. Returns `ok` (logged in) or `mfa_required` (code emailed).
 * Throws KaspiAuthError on bad credentials.
 */
export async function beginLogin(
  email: string,
  password: string,
  deviceCookies?: CookieJar | null,
): Promise<LoginResult> {
  const jar = Jar.from(deviceCookies);

  const res = await postLogin(jar, { _u: email, _p: password, _r_d: true });
  const data: unknown = await res.clone().json().catch(() => ({}));

  if (!res.ok) {
    // Inspect the error code BEFORE assuming bad credentials — a 401 can also
    // be a rate-limit, which must not be mislabeled as a wrong password.
    const code = errorCode(data);
    if (code === 'MFA_SEND_FLOOD' || code === 'MFA_CODE_TOO_MANY_SEND') {
      throw new KaspiAuthError(
        `Too many code requests for this Kaspi login.${waitPhrase(data)}`,
      );
    }
    if (
      code === 'CREDENTIALS_INVALID' ||
      ((res.status === 401 || res.status === 403) && !code)
    ) {
      throw new KaspiAuthError('Kaspi rejected the login (wrong email/password).');
    }
    if (code === 'INSUFFICIENT_PERMISSIONS') {
      throw new KaspiAuthError(
        'This Kaspi login lacks cabinet access (INSUFFICIENT_PERMISSIONS).',
      );
    }
    throw new Error(`Kaspi login HTTP ${res.status}${code ? ` (${code})` : ''}`);
  }

  const d = (data ?? {}) as Record<string, unknown>;

  // Multi-merchant login: needs a merchant/user selection step we don't do yet.
  if (d.su) {
    throw new KaspiAuthError(
      'This Kaspi login manages multiple merchants; multi-merchant selection is not supported yet.',
    );
  }

  // MFA required: Kaspi auto-sent a 6-digit code to this email.
  if (typeof d.email === 'string') {
    return {
      status: 'mfa_required',
      emailSentTo: d.email,
      pending: { jar: jar.toJSON(), email: d.email },
    };
  }

  // Trusted device / already authenticated → finish the SSO exchange.
  return completeSso(jar);
}

/**
 * Step 2: submit the emailed 6-digit code for a `pending` login. With
 * remember=true Kaspi sets a persistent trusted-device cookie (captured in the
 * returned `deviceCookies`), so future logins won't need a code.
 */
export async function submitOtp(
  pending: MfaPending,
  code: string,
  remember = true,
): Promise<Extract<LoginResult, { status: 'ok' }>> {
  const jar = Jar.from(pending.jar);

  const res = await postLogin(jar, {
    _m_c: code.trim(),
    _r_d: remember,
    _u: pending.email,
  });
  const data: unknown = await res.clone().json().catch(() => ({}));

  if (!res.ok) {
    const c = errorCode(data);
    if (c === 'SECURITY_CODE_INVALID' || c === 'MFA_CODE_INVALID') {
      throw new KaspiAuthError('The code is incorrect. Check it and try again.');
    }
    if (c === 'TIMEOUT_EXCEEDED' || c === 'INACTIVE_CODE_ERROR') {
      throw new KaspiAuthError('The code has expired. Request a new one.');
    }
    if (c === 'MFA_CODE_ATTEMPT_LIMIT') {
      throw new KaspiAuthError(
        `Too many wrong attempts. Request a new code.${waitPhrase(data)}`,
      );
    }
    throw new Error(`Kaspi code verify HTTP ${res.status}${c ? ` (${c})` : ''}`);
  }

  const result = await completeSso(jar);
  return result as Extract<LoginResult, { status: 'ok' }>;
}
