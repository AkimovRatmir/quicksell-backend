import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNotNull, lt, lte, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import { type PaymentRow, payments, users } from '../database/schema';
import { LegalService } from '../legal/legal.service';
import {
  type FreedomFields,
  FreedomPayClient,
  FreedomPayError,
  PAYMENT_ID_FIELD,
} from './freedompay.client';

/** Pro, one month. Must match the price on the Tariff screen. */
export const PRO_PRICE_KZT = 15_000;
const PRO_DESCRIPTION = 'Подписка QuickSell Pro, 1 месяц';

/** Last path segment of our result URL — the "script" its signature is made for. */
export const RESULT_SCRIPT = 'result';
const RESULT_PATH = '/api/billing/freedom/result';

/** get_status3 answers that end a payment. Anything else keeps it pending. */
const FAILED_STATUSES = new Set(['failed', 'error']);

/** Don't ask FreedomPay about the same payment more often than this. */
const STATUS_CHECK_INTERVAL_MS = 3_000;
/** Pending this long with no answer from FreedomPay = give up on it. */
const PENDING_GIVE_UP_MS = 24 * 3_600_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the frontend sees of a payment. */
export interface PaymentView {
  id: string;
  status: string;
  amount: number;
  currency: string;
  paidAt: Date | null;
  /** New end of Pro produced by this payment. */
  paidUntil: Date | null;
  failureReason: string | null;
  createdAt: Date;
}

/**
 * Subscription payments through FreedomPay.
 *
 * The browser only ever displays FreedomPay's form. Whether a payment went
 * through is decided here, from two sources that both come from FreedomPay:
 * the signed server-to-server result callback, and our own status lookups
 * (get_status3). Nothing the browser says — success redirect included — can
 * grant Pro.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly lastStatusCheck = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly freedom: FreedomPayClient,
    private readonly legal: LegalService,
    private readonly config: ConfigService,
  ) {}

  private get appBaseUrl(): string {
    return (
      this.config.get<string>('APP_BASE_URL') ?? 'https://web.quicksell.kz'
    ).replace(/\/+$/, '');
  }

  /**
   * Start paying for Pro: record the attempt, create it at FreedomPay, hand
   * back the URL of their payment form (the frontend shows it in a popup).
   */
  async checkout(userId: string) {
    if (!this.freedom.isConfigured) {
      throw new ServiceUnavailableException('Оплата пока не подключена.');
    }

    const [user] = await this.db
      .select({ plan: users.plan, planExpiresAt: users.planExpiresAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new NotFoundException('User not found');
    if (user.plan === 'pro' && !user.planExpiresAt) {
      throw new ConflictException(
        'У вас бессрочный Pro — оплачивать не нужно.',
      );
    }
    if (!(await this.legal.hasAccepted(userId, 'subscription'))) {
      throw new ForbiddenException(
        'Сначала примите условия оферты и процедуры оплаты.',
      );
    }

    const [payment] = await this.db
      .insert(payments)
      .values({
        userId,
        plan: 'pro',
        amount: PRO_PRICE_KZT,
        currency: 'KZT',
        testMode: this.freedom.testMode,
      })
      .returning();

    // FreedomPay can only call back a public HTTPS address. On localhost the
    // result callback is left out and status lookups do its job.
    const base = this.appBaseUrl;
    const resultUrl = base.startsWith('https://')
      ? `${base}${RESULT_PATH}`
      : undefined;

    try {
      const created = await this.freedom.initPayment({
        paymentId: payment.id,
        amount: payment.amount,
        description: PRO_DESCRIPTION,
        userId,
        resultUrl,
        successUrl: `${base}/payment/return?status=success`,
        failureUrl: `${base}/payment/return?status=failure`,
      });
      await this.db
        .update(payments)
        .set({
          providerPaymentId: created.providerPaymentId,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));
      this.logger.log(
        `Payment ${payment.id} created (FreedomPay ${created.providerPaymentId}, test=${payment.testMode})`,
      );
      return {
        paymentId: payment.id,
        paymentUrl: created.paymentUrl,
        amount: payment.amount,
        currency: payment.currency,
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await this.markFailed(payment.id, `init_payment: ${reason}`);
      if (e instanceof FreedomPayError) {
        this.logger.error(`Payment ${payment.id} not created: ${reason}`);
        throw new ServiceUnavailableException(
          'Не удалось создать платёж. Попробуйте позже.',
        );
      }
      throw e;
    }
  }

  /**
   * One of the user's payments. While it is pending, FreedomPay is asked
   * directly — that's how the popup learns the outcome without waiting for
   * the callback (and the only way on localhost, where no callback arrives).
   */
  async paymentOf(userId: string, paymentId: string): Promise<PaymentView> {
    let payment = await this.find(paymentId);
    if (!payment || payment.userId !== userId) {
      throw new NotFoundException('Payment not found');
    }
    if (payment.status === 'pending' && payment.providerPaymentId) {
      const last = this.lastStatusCheck.get(payment.id) ?? 0;
      if (Date.now() - last >= STATUS_CHECK_INTERVAL_MS) {
        this.lastStatusCheck.set(payment.id, Date.now());
        await this.reconcile(payment);
        payment = (await this.find(paymentId)) ?? payment;
      }
    }
    if (payment.status !== 'pending') this.lastStatusCheck.delete(payment.id);
    return view(payment);
  }

  /**
   * FreedomPay's result callback. Returns the signed XML answer they expect:
   * `ok` (accepted), `rejected` (cancel the charge — only honoured when they
   * sent pg_can_reject=1) or `error`.
   *
   * Called more than once for the same payment when an earlier answer didn't
   * reach them; every step below is safe to repeat.
   */
  async handleResult(
    fields: FreedomFields,
  ): Promise<{ valid: boolean; xml: string }> {
    if (!this.freedom.verify(RESULT_SCRIPT, fields)) {
      this.logger.warn(
        `Result callback with a bad signature (FreedomPay payment ${fields.pg_payment_id ?? '?'})`,
      );
      return { valid: false, xml: this.reply('error', 'Invalid signature') };
    }

    const payment = await this.findForCallback(fields);
    if (!payment) {
      this.logger.error(
        `Result callback for an unknown payment (ours ${fields[PAYMENT_ID_FIELD] ?? '?'}, FreedomPay ${fields.pg_payment_id ?? '?'})`,
      );
      return { valid: true, xml: this.reply('error', 'Unknown order') };
    }

    const refuse = fields.pg_can_reject === '1' ? 'rejected' : 'ok';
    const problem = this.mismatch(payment, {
      amount: fields.pg_amount,
      currency: fields.pg_currency,
      testMode: fields.pg_testing_mode,
    });
    if (problem) {
      this.logger.error(`Payment ${payment.id} refused: ${problem}`);
      await this.markFailed(payment.id, problem);
      return { valid: true, xml: this.reply(refuse, 'Платёж отклонён') };
    }

    if (fields.pg_result === '1') {
      await this.markPaid(payment, {
        providerPaymentId: fields.pg_payment_id,
        cardPan: fields.pg_card_pan,
      });
      return { valid: true, xml: this.reply('ok', 'Оплата принята') };
    }
    if (fields.pg_result === '0') {
      await this.markFailed(
        payment.id,
        fields.pg_failure_description || 'Платёж не прошёл',
      );
    }
    // pg_result=2: not finished yet — nothing to record.
    return { valid: true, xml: this.reply('ok', 'Принято') };
  }

  /** Paid Pro that ran out goes back to Free. Admin-granted Pro has no end date. */
  async expirePlans(): Promise<number> {
    const expired = await this.db
      .update(users)
      .set({ plan: 'free', planExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(users.plan, 'pro'), lte(users.planExpiresAt, new Date())))
      .returning({ id: users.id });
    if (expired.length) {
      this.logger.log(`Pro expired for ${expired.length} account(s)`);
    }
    return expired.length;
  }

  /**
   * Safety net for payments whose outcome never reached us — the user closed
   * the popup, the callback failed. Asks FreedomPay about each, gives up on
   * ones pending for a day.
   */
  async reconcilePending(limit = 20): Promise<void> {
    const before = new Date(Date.now() - 2 * 60_000);
    const stale = await this.db
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.status, 'pending'),
          isNotNull(payments.providerPaymentId),
          lt(payments.createdAt, before),
        ),
      )
      .limit(limit);

    for (const payment of stale) {
      await this.reconcile(payment);
      const age = Date.now() - payment.createdAt.getTime();
      if (age > PENDING_GIVE_UP_MS) {
        await this.markFailed(payment.id, 'No answer from FreedomPay in 24 h');
      }
      // FreedomPay asks for 1.5–2 s between consecutive calls.
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  /** Ask FreedomPay how a pending payment ended and record the answer. */
  private async reconcile(payment: PaymentRow): Promise<void> {
    if (!payment.providerPaymentId) return;
    let st;
    try {
      st = await this.freedom.status(payment.providerPaymentId);
    } catch (e) {
      // "Payment not found" while the form is still open, or FreedomPay is
      // down: either way nothing to record yet.
      this.logger.debug(
        `Status of ${payment.id} unavailable: ${e instanceof Error ? e.message : e}`,
      );
      return;
    }

    if (st.status === 'success') {
      const problem = this.mismatch(payment, {
        amount: st.amount !== undefined ? String(st.amount) : undefined,
        currency: st.currency,
        testMode: st.testMode,
      });
      if (problem) {
        this.logger.error(`Payment ${payment.id} refused: ${problem}`);
        await this.markFailed(payment.id, problem);
        return;
      }
      await this.markPaid(payment, {
        providerPaymentId: st.providerPaymentId,
        cardPan: st.cardPan,
      });
    } else if (FAILED_STATUSES.has(st.status)) {
      await this.markFailed(
        payment.id,
        st.failureDescription || `Платёж не прошёл (${st.status})`,
      );
    }
  }

  /** Why FreedomPay's report can't be accepted for this payment, if it can't. */
  private mismatch(
    payment: PaymentRow,
    got: { amount?: string; currency?: string; testMode?: string },
  ): string | null {
    if (got.amount === undefined || Number(got.amount) !== payment.amount) {
      return `amount ${got.amount} ≠ ${payment.amount}`;
    }
    if (got.currency && got.currency !== payment.currency) {
      return `currency ${got.currency} ≠ ${payment.currency}`;
    }
    if (
      got.testMode !== undefined &&
      (got.testMode === '1') !== payment.testMode
    ) {
      return `test mode ${got.testMode} ≠ ${payment.testMode ? 1 : 0}`;
    }
    return null;
  }

  /**
   * Mark a payment paid and extend Pro by a month — exactly once per payment:
   * the status update only matches a row that isn't `paid` yet, so a repeated
   * callback or a callback racing a status check changes nothing the second
   * time.
   */
  private async markPaid(
    payment: PaymentRow,
    info: { providerPaymentId?: string; cardPan?: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [paid] = await tx
        .update(payments)
        .set({
          status: 'paid',
          paidAt: new Date(),
          providerPaymentId:
            info.providerPaymentId ?? payment.providerPaymentId,
          cardPan: info.cardPan ?? payment.cardPan,
          failureReason: null,
          updatedAt: new Date(),
        })
        .where(and(eq(payments.id, payment.id), ne(payments.status, 'paid')))
        .returning({ id: payments.id });
      if (!paid) return;

      // A month from today, or from the current end if Pro is still running.
      // Postgres clamps month ends: 31 Jan + 1 month = 28/29 Feb.
      const [user] = await tx
        .update(users)
        .set({
          plan: 'pro',
          planExpiresAt: sql`case
            when ${users.plan} = 'pro' and ${users.planExpiresAt} is null then null
            else greatest(coalesce(${users.planExpiresAt}, now()), now()) + interval '1 month'
          end`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, payment.userId))
        .returning({ planExpiresAt: users.planExpiresAt });

      await tx
        .update(payments)
        .set({ paidUntil: user?.planExpiresAt ?? null })
        .where(eq(payments.id, payment.id));

      this.logger.log(
        `Payment ${payment.id} paid — Pro until ${user?.planExpiresAt?.toISOString() ?? 'no end date'}`,
      );
    });
  }

  /** pending → failed. Leaves paid payments alone. */
  private async markFailed(paymentId: string, reason: string): Promise<void> {
    await this.db
      .update(payments)
      .set({
        status: 'failed',
        failureReason: reason.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')));
  }

  private async find(id: string): Promise<PaymentRow | null> {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * The payment a (signature-checked) callback is about: by our id from the
   * custom field, else by FreedomPay's pg_payment_id. When both are there
   * they must name the same payment.
   */
  private async findForCallback(
    fields: FreedomFields,
  ): Promise<PaymentRow | null> {
    const ours = fields[PAYMENT_ID_FIELD] ?? fields.pg_order_id ?? '';
    const theirs = fields.pg_payment_id;
    let payment = UUID_RE.test(ours) ? await this.find(ours) : null;
    if (!payment && theirs) {
      [payment = null] = await this.db
        .select()
        .from(payments)
        .where(eq(payments.providerPaymentId, theirs))
        .limit(1);
    }
    if (
      payment?.providerPaymentId &&
      theirs &&
      payment.providerPaymentId !== theirs
    ) {
      this.logger.error(
        `Callback names payment ${payment.id} but FreedomPay payment ${theirs}, not ${payment.providerPaymentId}`,
      );
      return null;
    }
    return payment;
  }

  private reply(status: 'ok' | 'rejected' | 'error', description: string) {
    return this.freedom.reply(RESULT_SCRIPT, {
      pg_status: status,
      pg_description: description,
    });
  }
}

function view(p: PaymentRow): PaymentView {
  return {
    id: p.id,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    paidAt: p.paidAt,
    paidUntil: p.paidUntil,
    failureReason: p.status === 'failed' ? p.failureReason : null,
    createdAt: p.createdAt,
  };
}
