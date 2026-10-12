import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Flat FreedomPay message: every field travels as a string. */
export type FreedomFields = Record<string, string>;

const DEFAULT_API_URL = 'https://api.freedompay.kz';
const REQUEST_TIMEOUT_MS = 20_000;
// FreedomPay's firewall answers 403 to generic client user agents (python's
// urllib was refused outright), so every call names itself.
const USER_AGENT = 'QuickSell/1.0 (+https://web.quicksell.kz)';

/**
 * pg_sig for one message: md5 over the script name, every field value ordered
 * by field name, and the secret key, joined with ';'. Script = the last path
 * segment of the URL being called: 'init_payment.php', or 'result' for our
 * own callback URL.
 */
export function freedomSignature(
  script: string,
  fields: FreedomFields,
  secret: string,
): string {
  const values = Object.keys(fields)
    .filter((k) => k !== 'pg_sig')
    .sort()
    .map((k) => fields[k]);
  return createHash('md5')
    .update([script, ...values, secret].join(';'))
    .digest('hex');
}

/**
 * Top-level leaf elements of a FreedomPay `<response>` as a flat map. Nested
 * blocks (the refund list in a status answer) are skipped — nothing here reads
 * them.
 */
export function parseFreedomXml(xml: string): FreedomFields {
  const inner = /<response[^>]*>([\s\S]*)<\/response\s*>/i.exec(xml)?.[1];
  if (inner === undefined) {
    throw new Error(`Not a FreedomPay XML answer: ${xml.slice(0, 200)}`);
  }
  const out: FreedomFields = {};
  const element =
    /\s*(?:<([\w-]+)\s*\/>|<([\w-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\2\s*>)/y;
  let m: RegExpExecArray | null;
  while ((m = element.exec(inner))) {
    if (m[1]) {
      out[m[1]] = '';
      continue;
    }
    const cdata = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(m[3]);
    if (cdata) out[m[2]] = cdata[1];
    else if (!m[3].includes('<')) out[m[2]] = decodeXml(m[3]);
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** FreedomPay answered, but with pg_status=error. */
export class FreedomPayError extends Error {
  constructor(
    readonly code: string,
    readonly description: string,
  ) {
    super(`FreedomPay error ${code}: ${description}`);
  }
}

/**
 * Our payments.id travels in this custom field. FreedomPay hands every field
 * without the pg_ prefix back to the result URL, under the signature.
 */
export const PAYMENT_ID_FIELD = 'qs_payment_id';

export interface InitPaymentArgs {
  /** Our payments.id — comes back in PAYMENT_ID_FIELD in the result callback. */
  paymentId: string;
  amount: number;
  description: string;
  userId: string;
  /** Server-to-server result callback. Omitted when it can't be reached (localhost). */
  resultUrl?: string;
  successUrl: string;
  failureUrl: string;
}

/** What get_status3 says about one of our payments. */
export interface FreedomPaymentStatus {
  /** pg_payment_status: 'success', 'pending', 'failed', … */
  status: string;
  amount?: number;
  currency?: string;
  providerPaymentId?: string;
  cardPan?: string;
  failureDescription?: string;
  /** pg_testing_mode as FreedomPay recorded it. */
  testMode?: string;
}

/**
 * FreedomPay Merchant API over plain `fetch`, like MailService does for
 * Resend: the handful of calls billing needs, signing, and checking the
 * signature on FreedomPay's callbacks to us.
 *
 * Answers to our own calls are trusted without re-checking their pg_sig: they
 * arrive over TLS from the host we dialled. Callbacks come from the open
 * internet, so those are always verified (`verify`).
 */
@Injectable()
export class FreedomPayClient {
  private readonly logger = new Logger(FreedomPayClient.name);

  constructor(private readonly config: ConfigService) {}

  private get merchantId(): string | undefined {
    return this.config.get<string>('FREEDOM_MERCHANT_ID');
  }

  private get secret(): string | undefined {
    return this.config.get<string>('FREEDOM_SECRET_KEY');
  }

  private get apiUrl(): string {
    return (
      this.config.get<string>('FREEDOM_API_URL') ?? DEFAULT_API_URL
    ).replace(/\/+$/, '');
  }

  get isConfigured(): boolean {
    return !!this.merchantId && !!this.secret;
  }

  /**
   * Payments are created with pg_testing_mode=1 unless FREEDOM_TEST_MODE=0.
   * Test is the default so a forgotten variable can't take real money.
   */
  get testMode(): boolean {
    return this.config.get<string>('FREEDOM_TEST_MODE') !== '0';
  }

  /** Does this incoming message carry a valid signature for `script`? */
  verify(script: string, fields: FreedomFields): boolean {
    if (!this.secret || !fields.pg_sig) return false;
    const expected = Buffer.from(freedomSignature(script, fields, this.secret));
    const got = Buffer.from(fields.pg_sig.toLowerCase());
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** A signed XML answer to one of FreedomPay's callbacks. */
  reply(script: string, fields: FreedomFields): string {
    const signed: FreedomFields = {
      ...fields,
      pg_salt: randomBytes(8).toString('hex'),
    };
    signed.pg_sig = freedomSignature(script, signed, this.secret ?? '');
    const body = Object.entries(signed)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join('');
    return `<?xml version="1.0" encoding="utf-8"?><response>${body}</response>`;
  }

  /**
   * Create a payment and get the URL of FreedomPay's payment form for it.
   *
   * No pg_order_id: on shop #589950 FreedomPay fails every request that has
   * one ('Attempt to read property "payments_order_unique" on null' — the
   * shop's order-uniqueness setting is missing on their side). Nothing here
   * depends on it: our id goes in PAYMENT_ID_FIELD, and lookups use their
   * pg_payment_id.
   */
  async initPayment(
    args: InitPaymentArgs,
  ): Promise<{ providerPaymentId: string; paymentUrl: string }> {
    const fields: FreedomFields = {
      [PAYMENT_ID_FIELD]: args.paymentId,
      pg_amount: String(args.amount),
      pg_currency: 'KZT',
      pg_description: args.description,
      pg_testing_mode: this.testMode ? '1' : '0',
      pg_language: 'ru',
      // The form stays valid for 30 minutes.
      pg_lifetime: '1800',
      pg_user_id: args.userId,
      pg_success_url: args.successUrl,
      pg_failure_url: args.failureUrl,
      pg_request_method: 'POST',
    };
    if (args.resultUrl) fields.pg_result_url = args.resultUrl;

    const res = await this.call('init_payment.php', fields);
    if (!res.pg_redirect_url || !res.pg_payment_id) {
      throw new FreedomPayError(
        'no_url',
        'init_payment returned no redirect URL',
      );
    }
    return {
      providerPaymentId: res.pg_payment_id,
      paymentUrl: res.pg_redirect_url,
    };
  }

  /**
   * Current state of a payment, by FreedomPay's pg_payment_id. An unpaid one
   * reports 'new'.
   */
  async status(providerPaymentId: string): Promise<FreedomPaymentStatus> {
    const res = await this.call('get_status3.php', {
      pg_payment_id: providerPaymentId,
    });
    return {
      status: res.pg_payment_status ?? 'unknown',
      amount: res.pg_amount !== undefined ? Number(res.pg_amount) : undefined,
      currency: res.pg_currency,
      providerPaymentId: res.pg_payment_id,
      cardPan: res.pg_card_pan,
      failureDescription: res.pg_failure_description,
      testMode: res.pg_testing_mode,
    };
  }

  private async call(
    script: string,
    fields: FreedomFields,
  ): Promise<FreedomFields> {
    if (!this.merchantId || !this.secret) {
      throw new ServiceUnavailableException('Оплата пока не подключена.');
    }
    const signed: FreedomFields = {
      ...fields,
      pg_merchant_id: this.merchantId,
      pg_salt: randomBytes(8).toString('hex'),
    };
    signed.pg_sig = freedomSignature(script, signed, this.secret);

    let answer: FreedomFields;
    try {
      const res = await fetch(`${this.apiUrl}/${script}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams(signed),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      answer = parseFreedomXml(text);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.logger.error(`${script} did not go through: ${reason}`);
      throw new ServiceUnavailableException(
        'Платёжная система сейчас недоступна. Попробуйте позже.',
      );
    }

    if (answer.pg_status === 'error') {
      throw new FreedomPayError(
        answer.pg_error_code ?? '?',
        answer.pg_error_description ?? 'no description',
      );
    }
    return answer;
  }
}
