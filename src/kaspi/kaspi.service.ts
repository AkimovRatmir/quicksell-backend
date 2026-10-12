import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { AnalyticsService } from '../analytics/analytics.service';
import { decryptSecret, encryptSecret } from '../crypto/crypto.util';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import {
  kaspiAuthPending,
  type KaspiAuthPendingRow,
  kaspiOrderEntries,
  kaspiOrders,
  kaspiProducts,
  type NewKaspiOrder,
  type NewKaspiOrderEntry,
  type NewKaspiProduct,
  type SellerRow,
  sellers,
} from '../database/schema';
import { CreateSellerDto } from './dto/create-seller.dto';
import { UpdateSellerDto } from './dto/update-seller.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import {
  beginLogin,
  type CookieJar,
  type MfaPending,
  submitOtp,
} from './kaspi-auth.client';
import {
  fetchAllOffers,
  fetchMerchantUid,
  KaspiAuthError,
  type KaspiOffer,
  MultipleMerchantsError,
} from './kaspi.client';
import {
  fetchActiveOrders,
  fetchOrderEntries,
  fetchOrders,
  type KaspiOrder,
  type KaspiOrderEntryAttributes,
} from './kaspi-orders.client';
import type { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { mapPool, runPool } from './run-pool';

/**
 * Order sync windows (days).
 * - BACKFILL: one-time first-login pull. 89 (not 90) to stay safely inside
 *   Kaspi's accepted creationDate range.
 * - INCREMENTAL: daily cron + manual refresh. 14 = KZ return window, so we
 *   re-pull recent orders to catch a status flip (returned/cancelled).
 */
const ORDER_BACKFILL_DAYS = 89;
const ORDER_INCREMENTAL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pause before the second try at line items that failed. A network blip fails
 * a whole run of requests within the same second, so retrying at once would
 * only fail again.
 */
const ENTRY_RETRY_DELAY_MS = 5_000;

/**
 * How many sellers a cron tick syncs at once. Each one mostly waits on Kaspi,
 * so running them one by one made the hourly job scale linearly with the
 * number of sellers. Kept low on purpose: this is also how hard we hit Kaspi.
 */
const SELLER_SYNC_CONCURRENCY = 5;

/** Line-item fetches in flight per seller, for the same reason. */
const ENTRY_FETCH_CONCURRENCY = 5;

/** Order codes per lookup query when checking what we already store. */
const ORDER_LOOKUP_CHUNK = 500;

/**
 * Shown on the seller (lastSyncError) while Kaspi waits for an emailed code.
 * Names the button in Settings that runs the interactive re-auth.
 */
const KASPI_CODE_REQUIRED_MESSAGE =
  'Kaspi запросил код подтверждения из письма. Нажмите «Войти в Kaspi заново» в Настройках и введите код.';

/**
 * Outcome of the line-item step for one order: pulled fresh, left alone
 * because the order has not moved, or the fetch failed. The last two both
 * leave what is stored untouched; they are told apart only so the sync can
 * still report how many line items it covered.
 */
type EntriesFetch =
  | { kind: 'fetched'; entries: KaspiOrderEntryAttributes[] }
  | { kind: 'unchanged'; count: number }
  | { kind: 'failed' };

/** The stored header fields that decide whether line items must be refetched. */
interface StoredOrderHead {
  code: string;
  state: string;
  status: string;
  totalPrice: number;
  entriesCount: number;
}

/** Columns safe to return — never the encrypted secret blobs. */
const sellerView = {
  id: sellers.id,
  userId: sellers.userId,
  name: sellers.name,
  kaspiMerchantUid: sellers.kaspiMerchantUid,
  cookieStatus: sellers.cookieStatus,
  lastSyncAt: sellers.lastSyncAt,
  lastSyncError: sellers.lastSyncError,
  createdAt: sellers.createdAt,
  updatedAt: sellers.updatedAt,
};

/** A seller row with no secret columns — safe to return to the client. */
export type SellerPublic = Pick<SellerRow, keyof typeof sellerView>;

/**
 * Outcome of a login/connect attempt: either the seller is connected, or Kaspi
 * emailed a code and we need the user to submit it (verifyOtp) with `pendingId`.
 */
export type ConnectResult =
  | { status: 'connected'; seller: SellerPublic }
  | { status: 'mfa_required'; pendingId: string; emailSentTo: string };

@Injectable()
export class KaspiService {
  private readonly logger = new Logger(KaspiService.name);

  /** Re-entrancy guards so overlapping cron ticks don't double-sync. */
  private syncingProducts = false;
  private syncingOrders = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly analytics: AnalyticsService,
  ) {}

  /** Step 1 of login, with HTTP-friendly errors. May return `mfa_required`. */
  private async loginStep(
    email: string,
    password: string,
    deviceCookies?: CookieJar | null,
  ) {
    try {
      return await beginLogin(email, password, deviceCookies);
    } catch (e) {
      if (e instanceof KaspiAuthError) {
        throw new UnauthorizedException(e.message);
      }
      throw new BadRequestException(
        `Kaspi login failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async deriveUid(cookie: string): Promise<string> {
    try {
      return await fetchMerchantUid(cookie);
    } catch (e) {
      if (e instanceof KaspiAuthError) {
        throw new UnauthorizedException(e.message);
      }
      if (e instanceof MultipleMerchantsError) {
        throw new BadRequestException(e.message);
      }
      throw new BadRequestException(
        `Could not derive merchant UID: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Connect a Kaspi seller. Preferred path: login + password → the backend logs
   * in headlessly. If Kaspi's device MFA kicks in, this returns
   * `mfa_required` + a `pendingId`; the frontend collects the emailed code and
   * calls `verifyOtp`. Legacy path: a pre-captured session cookie (no MFA).
   */
  async createSeller(
    userId: string,
    dto: CreateSellerDto,
  ): Promise<ConnectResult> {
    // Legacy path: a pasted cabinet cookie — no login flow, no MFA.
    if (dto.kaspiSessionCookie && !(dto.kaspiLogin && dto.kaspiPassword)) {
      const seller = await this.finalizeSeller(userId, {
        name: dto.name,
        kaspiMerchantUid: dto.kaspiMerchantUid,
        cabinetCookie: dto.kaspiSessionCookie,
        apiTokenEnc: dto.kaspiApiToken
          ? encryptSecret(dto.kaspiApiToken)
          : undefined,
      });
      return { status: 'connected', seller };
    }

    if (!(dto.kaspiLogin && dto.kaspiPassword)) {
      throw new BadRequestException(
        'Provide kaspiLogin + kaspiPassword (recommended) or a kaspiSessionCookie.',
      );
    }

    const result = await this.loginStep(dto.kaspiLogin, dto.kaspiPassword);
    if (result.status === 'ok') {
      const seller = await this.finalizeSeller(userId, {
        name: dto.name,
        kaspiMerchantUid: dto.kaspiMerchantUid,
        cabinetCookie: result.cabinetCookie,
        deviceCookies: result.deviceCookies,
        login: dto.kaspiLogin,
        password: dto.kaspiPassword,
        apiTokenEnc: dto.kaspiApiToken
          ? encryptSecret(dto.kaspiApiToken)
          : undefined,
      });
      return { status: 'connected', seller };
    }

    // MFA required — stash the pre-auth session and hand back a pending handle.
    const pendingId = await this.stashPending({
      userId,
      purpose: 'connect',
      pending: result.pending,
      emailSentTo: result.emailSentTo,
      login: dto.kaspiLogin,
      password: dto.kaspiPassword,
      meta: {
        name: dto.name,
        kaspiMerchantUid: dto.kaspiMerchantUid ?? null,
        apiTokenEnc: dto.kaspiApiToken
          ? encryptSecret(dto.kaspiApiToken)
          : null,
      },
    });
    return {
      status: 'mfa_required',
      pendingId,
      emailSentTo: result.emailSentTo,
    };
  }

  /**
   * Complete a `mfa_required` login by submitting the emailed code. On success
   * we persist the trusted-device cookies, so later syncs re-auth silently.
   */
  async verifyOtp(
    userId: string,
    pendingId: string,
    code: string,
  ): Promise<ConnectResult> {
    const pending = await this.loadPending(userId, pendingId);

    let result: Awaited<ReturnType<typeof submitOtp>>;
    try {
      result = await submitOtp(this.decodePending(pending), code);
    } catch (e) {
      if (e instanceof KaspiAuthError) {
        throw new UnauthorizedException(e.message);
      }
      throw new BadRequestException(
        `Kaspi code verification failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // Re-auth of an existing seller: just refresh its cookies.
    if (pending.purpose === 'reauth' && pending.sellerId) {
      const [row] = await this.db
        .update(sellers)
        .set({
          kaspiSessionCookieEnc: encryptSecret(result.cabinetCookie),
          kaspiDeviceCookiesEnc: encryptSecret(
            JSON.stringify(result.deviceCookies),
          ),
          cookieStatus: 'ok',
          kaspiCodeRequiredAt: null,
          lastSyncError: null,
          updatedAt: new Date(),
        })
        .where(eq(sellers.id, pending.sellerId))
        .returning(sellerView);
      await this.clearPending(pending.id);
      return { status: 'connected', seller: row };
    }

    // New connect: persist the seller with its login + cookies.
    const meta = pending.meta;
    const seller = await this.finalizeSeller(userId, {
      name: typeof meta.name === 'string' ? meta.name : undefined,
      kaspiMerchantUid:
        typeof meta.kaspiMerchantUid === 'string'
          ? meta.kaspiMerchantUid
          : undefined,
      cabinetCookie: result.cabinetCookie,
      deviceCookies: result.deviceCookies,
      login: decryptSecret(pending.loginEnc),
      password: decryptSecret(pending.passwordEnc),
      apiTokenEnc:
        typeof meta.apiTokenEnc === 'string' ? meta.apiTokenEnc : undefined,
    });
    await this.clearPending(pending.id);
    return { status: 'connected', seller };
  }

  /**
   * Email a fresh code for a pending login (Kaspi rate-limits this). We resend
   * by re-running the password step rather than Kaspi's `/api/p/mfa/send`,
   * which 500s for our headless session. That mints a new pre-auth session, so
   * we overwrite the pending row's jar and expiry to match the new code.
   */
  async resendOtpCode(
    userId: string,
    pendingId: string,
  ): Promise<{ emailSentTo: string }> {
    const pending = await this.loadPending(userId, pendingId);
    const login = decryptSecret(pending.loginEnc);
    const password = decryptSecret(pending.passwordEnc);

    const result = await this.loginStep(login, password);
    if (result.status !== 'mfa_required') {
      // Device became trusted between attempts — no code to resend. Drop the
      // pending row; the client should just retry connect/reauth.
      await this.clearPending(pending.id);
      throw new BadRequestException(
        'This login no longer needs a code. Please try connecting again.',
      );
    }

    await this.db
      .update(kaspiAuthPending)
      .set({
        jarEnc: encryptSecret(JSON.stringify(result.pending)),
        emailSentTo: result.emailSentTo,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      })
      .where(eq(kaspiAuthPending.id, pending.id));

    return { emailSentTo: result.emailSentTo };
  }

  /**
   * Upsert a seller by (user, merchant). Refreshes cookies/credentials on an
   * existing row (self-heals a `needs_reauth`), inserts otherwise. One row per
   * (user, merchant) — duplicates would multiply-count money in aggregations.
   */
  private async finalizeSeller(
    userId: string,
    args: {
      name?: string;
      kaspiMerchantUid?: string;
      cabinetCookie: string;
      deviceCookies?: CookieJar;
      login?: string;
      password?: string;
      apiTokenEnc?: string;
    },
  ): Promise<SellerPublic> {
    const uid =
      args.kaspiMerchantUid ?? (await this.deriveUid(args.cabinetCookie));

    const secrets = {
      kaspiSessionCookieEnc: encryptSecret(args.cabinetCookie),
      ...(args.deviceCookies
        ? {
            kaspiDeviceCookiesEnc: encryptSecret(
              JSON.stringify(args.deviceCookies),
            ),
          }
        : {}),
      ...(args.login ? { kaspiLoginEnc: encryptSecret(args.login) } : {}),
      ...(args.password
        ? { kaspiPasswordEnc: encryptSecret(args.password) }
        : {}),
      ...(args.apiTokenEnc ? { kaspiApiTokenEnc: args.apiTokenEnc } : {}),
    };

    const [existing] = await this.db
      .select({ id: sellers.id })
      .from(sellers)
      .where(and(eq(sellers.userId, userId), eq(sellers.kaspiMerchantUid, uid)))
      .limit(1);

    if (existing) {
      const [row] = await this.db
        .update(sellers)
        .set({
          ...(args.name ? { name: args.name } : {}),
          ...secrets,
          cookieStatus: 'ok',
          kaspiCodeRequiredAt: null,
          lastSyncError: null,
          updatedAt: new Date(),
        })
        .where(eq(sellers.id, existing.id))
        .returning(sellerView);
      return row;
    }

    const [row] = await this.db
      .insert(sellers)
      .values({
        userId,
        name: args.name ?? 'Kaspi',
        kaspiMerchantUid: uid,
        ...secrets,
      })
      .returning(sellerView);
    return row;
  }

  // --- MFA pending store (bridges the code-request and code-submit calls) ---

  private async stashPending(p: {
    userId: string;
    purpose: 'connect' | 'reauth';
    sellerId?: string;
    pending: MfaPending;
    emailSentTo: string;
    login: string;
    password: string;
    meta?: Record<string, unknown>;
  }): Promise<string> {
    // Opportunistically sweep dead rows (abandoned or timed-out logins).
    await this.db
      .delete(kaspiAuthPending)
      .where(lte(kaspiAuthPending.expiresAt, new Date()));

    const [row] = await this.db
      .insert(kaspiAuthPending)
      .values({
        userId: p.userId,
        purpose: p.purpose,
        sellerId: p.sellerId ?? null,
        jarEnc: encryptSecret(JSON.stringify(p.pending)),
        emailSentTo: p.emailSentTo,
        loginEnc: encryptSecret(p.login),
        passwordEnc: encryptSecret(p.password),
        meta: p.meta ?? {},
        // Kaspi's code lives ~180s; give the round-trip a little headroom.
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      })
      .returning({ id: kaspiAuthPending.id });
    return row.id;
  }

  private async loadPending(
    userId: string,
    pendingId: string,
  ): Promise<KaspiAuthPendingRow> {
    const [row] = await this.db
      .select()
      .from(kaspiAuthPending)
      .where(eq(kaspiAuthPending.id, pendingId))
      .limit(1);
    if (!row) {
      throw new NotFoundException('No pending login (it may have expired).');
    }
    if (row.userId !== userId) {
      throw new ForbiddenException('Not your login attempt');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      await this.clearPending(row.id);
      throw new BadRequestException(
        'This verification expired. Start the login again.',
      );
    }
    return row;
  }

  private decodePending(row: KaspiAuthPendingRow): MfaPending {
    return JSON.parse(decryptSecret(row.jarEnc)) as MfaPending;
  }

  private async clearPending(id: string): Promise<void> {
    await this.db.delete(kaspiAuthPending).where(eq(kaspiAuthPending.id, id));
  }

  listSellers(userId: string) {
    return this.db
      .select(sellerView)
      .from(sellers)
      .where(eq(sellers.userId, userId));
  }

  /**
   * Update a seller's credentials / name. Only provided fields change. Storing
   * a fresh cookie/login also clears the `needs_reauth` flag so the next sync
   * retries cleanly.
   */
  async updateSeller(id: string, userId: string, dto: UpdateSellerDto) {
    await this.ownedSeller(id, userId);

    const patch: Partial<typeof sellers.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.kaspiApiToken !== undefined) {
      patch.kaspiApiTokenEnc = encryptSecret(dto.kaspiApiToken);
    }
    if (dto.kaspiLogin !== undefined) {
      patch.kaspiLoginEnc = encryptSecret(dto.kaspiLogin);
    }
    if (dto.kaspiPassword !== undefined) {
      patch.kaspiPasswordEnc = encryptSecret(dto.kaspiPassword);
    }
    if (dto.kaspiSessionCookie !== undefined) {
      patch.kaspiSessionCookieEnc = encryptSecret(dto.kaspiSessionCookie);
    }
    // Fresh product-auth material → give the cookie flow a clean slate.
    if (
      dto.kaspiSessionCookie !== undefined ||
      dto.kaspiLogin !== undefined ||
      dto.kaspiPassword !== undefined
    ) {
      patch.cookieStatus = 'ok';
      patch.kaspiCodeRequiredAt = null;
      patch.lastSyncError = null;
    }

    if (Object.keys(patch).length === 1) {
      throw new BadRequestException('No updatable fields provided.');
    }

    const [row] = await this.db
      .update(sellers)
      .set(patch)
      .where(eq(sellers.id, id))
      .returning(sellerView);
    return row;
  }

  /** Resolve a seller and enforce ownership. Returns the full (encrypted) row. */
  private async ownedSeller(id: string, userId: string): Promise<SellerRow> {
    const [seller] = await this.db
      .select()
      .from(sellers)
      .where(eq(sellers.id, id))
      .limit(1);
    if (!seller) throw new NotFoundException(`Seller ${id} not found`);
    if (seller.userId !== userId) {
      throw new ForbiddenException('Not your seller');
    }
    return seller;
  }

  private toRow(sellerId: string, o: KaspiOffer): NewKaspiProduct {
    const totalStock = (o.availabilities ?? []).reduce(
      (s, a) => s + (a.stockCount ?? 0),
      0,
    );
    return {
      sellerId,
      sku: o.sku,
      offerId: o.offerId ?? null,
      title: o.title ?? o.model ?? o.sku,
      brand: o.brandName ?? o.brand ?? o.brandCode ?? null,
      masterCategory: o.masterCategory ?? null,
      priceMin: Math.round(o.minPrice ?? 0),
      priceMax: Math.round(o.maxPrice ?? 0),
      available: o.available ?? false,
      totalStock,
      availabilities: o.availabilities ?? [],
      images: o.images ?? [],
      kaspiUpdatedAt: o.updatedAt ? new Date(o.updatedAt) : null,
      syncedAt: new Date(),
    };
  }

  private async flagReauth(seller: SellerRow, error: string) {
    await this.db
      .update(sellers)
      .set({
        cookieStatus: 'needs_reauth',
        lastSyncError: error,
        updatedAt: new Date(),
      })
      .where(eq(sellers.id, seller.id));
  }

  private credentials(
    seller: SellerRow,
  ): { email: string; password: string } | null {
    if (!seller.kaspiLoginEnc || !seller.kaspiPasswordEnc) return null;
    return {
      email: decryptSecret(seller.kaspiLoginEnc),
      password: decryptSecret(seller.kaspiPasswordEnc),
    };
  }

  private deviceCookies(seller: SellerRow): CookieJar | null {
    if (!seller.kaspiDeviceCookiesEnc) return null;
    return JSON.parse(decryptSecret(seller.kaspiDeviceCookiesEnc)) as CookieJar;
  }

  /**
   * Silent re-auth for syncs: replays the stored trusted-device cookies so no
   * email code is needed. If Kaspi's device trust has expired it demands a code
   * again — which we can't answer headlessly — so we throw KaspiAuthError and
   * the caller flags `needs_reauth` (the user re-verifies via beginReauth).
   */
  private async reloginAndStore(seller: SellerRow): Promise<string> {
    const creds = this.credentials(seller);
    if (!creds) {
      throw new UnauthorizedException(
        'Session expired and no stored Kaspi credentials to refresh it.',
      );
    }
    // Kaspi already asked this seller for an emailed code and nobody has
    // entered it. Running the password step again would only make Kaspi send
    // another one, so stay out until the seller re-verifies interactively.
    if (seller.kaspiCodeRequiredAt) {
      throw new KaspiAuthError(KASPI_CODE_REQUIRED_MESSAGE);
    }
    this.logger.log(`Re-logging in seller ${seller.id} (cookie refresh)`);
    const result = await beginLogin(
      creds.email,
      creds.password,
      this.deviceCookies(seller),
    );
    if (result.status !== 'ok') {
      // The password step itself just made Kaspi email a code. Record it so
      // the next sync doesn't repeat the step (and the email).
      await this.db
        .update(sellers)
        .set({ kaspiCodeRequiredAt: new Date(), updatedAt: new Date() })
        .where(eq(sellers.id, seller.id));
      throw new KaspiAuthError(KASPI_CODE_REQUIRED_MESSAGE);
    }
    await this.db
      .update(sellers)
      .set({
        kaspiSessionCookieEnc: encryptSecret(result.cabinetCookie),
        kaspiDeviceCookiesEnc: encryptSecret(
          JSON.stringify(result.deviceCookies),
        ),
        cookieStatus: 'ok',
        kaspiCodeRequiredAt: null,
        updatedAt: new Date(),
      })
      .where(eq(sellers.id, seller.id));
    return result.cabinetCookie;
  }

  /**
   * Start an interactive re-auth of an existing seller (device trust expired).
   * If the stored device cookies still work it refreshes silently; otherwise
   * Kaspi emails a code and this returns `mfa_required` for the user to verify.
   */
  async beginReauth(userId: string, sellerId: string): Promise<ConnectResult> {
    const seller = await this.ownedSeller(sellerId, userId);
    const creds = this.credentials(seller);
    if (!creds) {
      throw new BadRequestException(
        'No stored Kaspi login for this seller — reconnect it with login + password.',
      );
    }

    const result = await this.loginStep(
      creds.email,
      creds.password,
      this.deviceCookies(seller),
    );
    if (result.status === 'ok') {
      const [row] = await this.db
        .update(sellers)
        .set({
          kaspiSessionCookieEnc: encryptSecret(result.cabinetCookie),
          kaspiDeviceCookiesEnc: encryptSecret(
            JSON.stringify(result.deviceCookies),
          ),
          cookieStatus: 'ok',
          kaspiCodeRequiredAt: null,
          lastSyncError: null,
          updatedAt: new Date(),
        })
        .where(eq(sellers.id, seller.id))
        .returning(sellerView);
      return { status: 'connected', seller: row };
    }

    const pendingId = await this.stashPending({
      userId,
      purpose: 'reauth',
      sellerId: seller.id,
      pending: result.pending,
      emailSentTo: result.emailSentTo,
      login: creds.email,
      password: creds.password,
    });
    return {
      status: 'mfa_required',
      pendingId,
      emailSentTo: result.emailSentTo,
    };
  }

  /** Stored cookie if present, else mint one from stored credentials. */
  private async ensureCookie(seller: SellerRow): Promise<string> {
    if (seller.kaspiSessionCookieEnc) {
      return decryptSecret(seller.kaspiSessionCookieEnc);
    }
    return this.reloginAndStore(seller);
  }

  /**
   * Core sync used by both the on-demand endpoint and the cron job.
   * On an auth failure it auto-relogins from stored credentials and retries
   * once; only flags `needs_reauth` if that also fails.
   */
  private async runSync(seller: SellerRow) {
    let cookie: string;
    try {
      cookie = await this.ensureCookie(seller);
    } catch (e) {
      if (e instanceof KaspiAuthError) {
        await this.flagReauth(seller, e.message);
        throw new UnauthorizedException(e.message);
      }
      throw e;
    }

    let offers: KaspiOffer[];
    let total: number;
    try {
      ({ offers, total } = await fetchAllOffers(
        cookie,
        seller.kaspiMerchantUid,
      ));
    } catch (e) {
      // Auth failure → try a single relogin+retry before giving up.
      if (e instanceof KaspiAuthError && this.credentials(seller)) {
        try {
          const fresh = await this.reloginAndStore(seller);
          ({ offers, total } = await fetchAllOffers(
            fresh,
            seller.kaspiMerchantUid,
          ));
        } catch (e2) {
          const msg = e2 instanceof Error ? e2.message : String(e2);
          await this.flagReauth(seller, msg);
          throw new UnauthorizedException(msg);
        }
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        const isAuth = e instanceof KaspiAuthError;
        await this.db
          .update(sellers)
          .set({
            cookieStatus: isAuth ? 'needs_reauth' : seller.cookieStatus,
            lastSyncError: msg,
            updatedAt: new Date(),
          })
          .where(eq(sellers.id, seller.id));
        if (isAuth) throw new UnauthorizedException(msg);
        throw e;
      }
    }

    const rows = offers
      .filter((o) => o.sku)
      .map((o) => this.toRow(seller.id, o));
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await this.db
        .insert(kaspiProducts)
        .values(chunk)
        .onConflictDoUpdate({
          target: [kaspiProducts.sellerId, kaspiProducts.sku],
          set: {
            offerId: sql`excluded.offer_id`,
            title: sql`excluded.title`,
            brand: sql`excluded.brand`,
            masterCategory: sql`excluded.master_category`,
            priceMin: sql`excluded.price_min`,
            priceMax: sql`excluded.price_max`,
            available: sql`excluded.available`,
            totalStock: sql`excluded.total_stock`,
            availabilities: sql`excluded.availabilities`,
            images: sql`excluded.images`,
            kaspiUpdatedAt: sql`excluded.kaspi_updated_at`,
            syncedAt: sql`excluded.synced_at`,
            // Reactivate if this SKU previously vanished and came back.
            archivedAt: sql`NULL`,
          },
        });
      upserted += chunk.length;
    }

    // Soft-archive previously-active rows whose SKUs weren't in this sync.
    // Defensive: skip if Kaspi returned 0 offers so we don't nuke the catalog
    // from a flaky response.
    let archived = 0;
    if (rows.length > 0) {
      const currentSkus = rows.map((r) => r.sku);
      const archivedRows = await this.db
        .update(kaspiProducts)
        .set({ archivedAt: new Date() })
        .where(
          and(
            eq(kaspiProducts.sellerId, seller.id),
            isNull(kaspiProducts.archivedAt),
            notInArray(kaspiProducts.sku, currentSkus),
          ),
        )
        .returning({ sku: kaspiProducts.sku });
      archived = archivedRows.length;
    }

    const pricePoints = await this.recordPriceChanges(seller.id);

    await this.db
      .update(sellers)
      .set({
        cookieStatus: 'ok',
        lastSyncAt: new Date(),
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(sellers.id, seller.id));

    return {
      sellerId: seller.id,
      total,
      fetched: offers.length,
      upserted,
      archived,
      pricePoints,
    };
  }

  /**
   * Засечка в «Историю цены продажи» для товаров, у которых цена на витрине
   * изменилась. Вызывается после апсерта: сам `price_min` перезаписывается
   * каждым синком, так что без этой записи прошлое значение исчезает навсегда.
   *
   * Сравниваем с последней засечкой ИМЕННО с источником 'kaspi_sync': в
   * истории лежат ещё и точки 'order' (цены, по которым реально покупали,
   * засеянные из заказов). Сравнение витринной цены с ценой продажи плодило бы
   * ложные «изменения» там, где менялась не цена, а скидка.
   */
  private async recordPriceChanges(sellerId: string): Promise<number> {
    const inserted = (await this.db.execute(sql`
      INSERT INTO product_price_history (seller_id, sku, price, observed_at, source)
      SELECT p.seller_id, p.sku, p.price_min, now(), 'kaspi_sync'
        FROM kaspi_products p
        LEFT JOIN LATERAL (
          SELECT h.price FROM product_price_history h
           WHERE h.seller_id = p.seller_id AND h.sku = p.sku
             AND h.source = 'kaspi_sync'
           ORDER BY h.observed_at DESC LIMIT 1
        ) last ON TRUE
       WHERE p.seller_id = ${sellerId}
         AND p.price_min > 0
         AND (last.price IS NULL OR last.price <> p.price_min)
      ON CONFLICT ON CONSTRAINT uq_price_hist_point DO NOTHING
      RETURNING id
    `)) as unknown as Array<unknown>;
    return inserted.length;
  }

  async syncProducts(id: string, userId: string) {
    const seller = await this.ownedSeller(id, userId);
    return this.runSync(seller);
  }

  /** Cron entrypoint: sync every seller that has a cookie and isn't flagged. */
  async syncAllDue() {
    if (this.syncingProducts) {
      this.logger.warn('Product auto-sync skipped: previous run still running');
      return;
    }
    this.syncingProducts = true;
    try {
      // Sync anything we can authenticate: a stored cookie, OR credentials we
      // can re-login with (these self-heal a needs_reauth state) — except
      // sellers waiting on a Kaspi email code. Nothing a cron does can finish
      // their login, and trying would email them another code every hour.
      const due = await this.db
        .select()
        .from(sellers)
        .where(
          and(
            isNull(sellers.kaspiCodeRequiredAt),
            or(
              isNotNull(sellers.kaspiSessionCookieEnc),
              and(
                isNotNull(sellers.kaspiLoginEnc),
                isNotNull(sellers.kaspiPasswordEnc),
              ),
            ),
          ),
        );
      this.logger.log(`Auto-sync: ${due.length} seller(s) due`);
      await runPool(due, SELLER_SYNC_CONCURRENCY, async (seller) => {
        try {
          const r = await this.runSync(seller);
          this.logger.log(`Auto-sync ${seller.id}: upserted ${r.upserted}`);
        } catch (e) {
          this.logger.warn(
            `Auto-sync ${seller.id} failed: ${e instanceof Error ? e.message : e}`,
          );
        }
      });
    } finally {
      this.syncingProducts = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Orders (official Kaspi Shop API — X-Auth-Token). Archive orders → analytics.
  // ---------------------------------------------------------------------------

  private sellerToken(seller: SellerRow): string {
    if (!seller.kaspiApiTokenEnc) {
      throw new BadRequestException(
        'This seller has no Kaspi API token. Add its X-Auth-Token to sync orders.',
      );
    }
    return decryptSecret(seller.kaspiApiTokenEnc);
  }

  private toOrderRow(seller: SellerRow, o: KaspiOrder): NewKaspiOrder {
    const a = o.attributes;
    const asDate = (ms?: number) =>
      typeof ms === 'number' ? new Date(ms) : null;
    return {
      sellerId: seller.id,
      code: a.code,
      state: a.state,
      status: a.status,
      totalPrice: Math.round(a.totalPrice ?? 0),
      deliveryCost: Math.round(a.deliveryCost ?? 0),
      deliveryCostForSeller: Math.round(a.deliveryCostForSeller ?? 0),
      paymentMode: a.paymentMode ?? null,
      deliveryMode: a.deliveryMode ?? null,
      isKaspiDelivery: a.isKaspiDelivery ?? false,
      preOrder: a.preOrder ?? false,
      signatureRequired: a.signatureRequired ?? false,
      assembled: a.assembled ?? false,
      pickupPointId: a.pickupPointId ?? null,
      customerName: a.customer?.name ?? null,
      customerCell: a.customer?.cellPhone ?? null,
      deliveryTown: a.deliveryAddress?.town ?? null,
      creationDate: asDate(a.creationDate),
      approvedByBankDate: asDate(a.approvedByBankDate),
      completionDate: asDate(a.completionDate),
      cancellationReason: a.cancellationReason ?? null,
      creditTerm: typeof a.creditTerm === 'number' ? a.creditTerm : null,
      syncedAt: new Date(),
    };
  }

  private toEntryRow(
    orderId: string,
    sellerId: string,
    e: KaspiOrderEntryAttributes,
    idx: number,
  ): NewKaspiOrderEntry {
    return {
      orderId,
      sellerId,
      entryNumber: e.entryNumber ?? idx,
      offerCode: e.offer?.code ?? null,
      offerName: e.offer?.name ?? null,
      categoryCode: e.category?.code ?? null,
      categoryTitle: e.category?.title ?? null,
      barCode: e.barCode ?? null,
      quantity: e.quantity ?? 0,
      basePrice: Math.round(e.basePrice ?? 0),
      totalPrice: Math.round(e.totalPrice ?? 0),
      unitType: e.unitType ?? null,
    };
  }

  /**
   * Core order sync: pull ARCHIVE orders created in the last `sinceDays` days
   * (default 30), plus each order's line items, and upsert. Used by the
   * endpoint and the cron.
   */
  private async runOrderSync(seller: SellerRow, sinceDays = 30) {
    const token = this.sellerToken(seller);
    const now = Date.now();
    const geMs = now - sinceDays * DAY_MS;

    let orders: KaspiOrder[];
    try {
      orders = await fetchOrders(token, geMs, now, 'ARCHIVE');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.db
        .update(sellers)
        .set({ lastSyncError: msg, updatedAt: new Date() })
        .where(eq(sellers.id, seller.id));
      if (e instanceof KaspiAuthError) throw new UnauthorizedException(msg);
      throw e;
    }

    // What we already store for these orders — decides whose line items still
    // need fetching. One query instead of one request per order.
    const stored = await this.storedOrders(
      seller.id,
      orders.map((o) => o.attributes.code),
    );

    let upserted = 0;
    let entriesUpserted = 0;
    let refetched = 0;
    const failed: KaspiOrder[] = [];
    for (let i = 0; i < orders.length; i += ENTRY_FETCH_CONCURRENCY) {
      const batch = orders.slice(i, i + ENTRY_FETCH_CONCURRENCY);

      // Fetch line items BEFORE the transaction (slow network — don't hold a
      // DB tx open for it), several at a time since each is just waiting on
      // Kaspi. `null` = nothing to write: either the fetch failed or the order
      // has not moved, and in both cases the stored entries stay untouched so
      // a network blip can never wipe money data.
      const results = await mapPool(
        batch,
        ENTRY_FETCH_CONCURRENCY,
        async (order): Promise<EntriesFetch> => {
          const prev = stored.get(order.attributes.code);
          if (!this.entriesAreStale(prev, order)) {
            return { kind: 'unchanged', count: prev?.entriesCount ?? 0 };
          }
          try {
            const entries = await fetchOrderEntries(token, order.id);
            refetched += 1;
            return { kind: 'fetched', entries };
          } catch (e) {
            this.logger.warn(
              `Order ${order.attributes.code} entries fetch failed (keeping existing): ${
                e instanceof Error ? e.message : e
              }`,
            );
            return { kind: 'failed' };
          }
        },
      );

      // Written one order at a time, in the order Kaspi returned them.
      for (const [j, order] of batch.entries()) {
        const result = results[j];
        await this.writeOrder(
          seller,
          order,
          result.kind === 'fetched' ? result.entries : null,
        );
        upserted += 1;
        // Line items this sync accounts for — unchanged ones already stored,
        // so the reported total means what it did before the skip existed.
        if (result.kind === 'fetched') entriesUpserted += result.entries.length;
        else if (result.kind === 'unchanged') entriesUpserted += result.count;
        else failed.push(order);
      }
    }

    // One more pass for line items that failed. Their headers are already
    // stored with entriesCount = 0; whatever still fails here is picked up by
    // a later sync (see orderSyncDays), even once it is older than 14 days.
    if (failed.length > 0) {
      await new Promise((r) => setTimeout(r, ENTRY_RETRY_DELAY_MS));
      const retried = await mapPool(
        failed,
        ENTRY_FETCH_CONCURRENCY,
        async (order) => {
          try {
            return await fetchOrderEntries(token, order.id);
          } catch {
            return null;
          }
        },
      );
      let recovered = 0;
      for (const [j, order] of failed.entries()) {
        const entries = retried[j];
        if (entries === null) continue;
        await this.writeOrder(seller, order, entries);
        recovered += 1;
        refetched += 1;
        entriesUpserted += entries.length;
      }
      this.logger.warn(
        `Order sync ${seller.id}: line items failed for ${failed.length} order(s), ${recovered} recovered on retry, ${failed.length - recovered} left for the next sync`,
      );
    }

    await this.db
      .update(sellers)
      .set({ lastSyncError: null, updatedAt: new Date() })
      .where(eq(sellers.id, seller.id));

    this.logger.log(
      `Order sync ${seller.id}: ${upserted} orders, entries refetched for ${refetched} of them`,
    );
    return { sellerId: seller.id, orders: upserted, entries: entriesUpserted };
  }

  /**
   * Header upsert + entries replace for one order, in one transaction: either
   * the whole order lands consistently or none of it does.
   *
   * `entries === null` leaves the stored line items (and `entriesCount`) alone.
   */
  private async writeOrder(
    seller: SellerRow,
    order: KaspiOrder,
    entries: KaspiOrderEntryAttributes[] | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(kaspiOrders)
        .values(this.toOrderRow(seller, order))
        .onConflictDoUpdate({
          target: [kaspiOrders.sellerId, kaspiOrders.code],
          set: {
            state: sql`excluded.state`,
            status: sql`excluded.status`,
            totalPrice: sql`excluded.total_price`,
            deliveryCost: sql`excluded.delivery_cost`,
            deliveryCostForSeller: sql`excluded.delivery_cost_for_seller`,
            paymentMode: sql`excluded.payment_mode`,
            deliveryMode: sql`excluded.delivery_mode`,
            isKaspiDelivery: sql`excluded.is_kaspi_delivery`,
            preOrder: sql`excluded.pre_order`,
            signatureRequired: sql`excluded.signature_required`,
            assembled: sql`excluded.assembled`,
            pickupPointId: sql`excluded.pickup_point_id`,
            customerName: sql`excluded.customer_name`,
            customerCell: sql`excluded.customer_cell`,
            deliveryTown: sql`excluded.delivery_town`,
            creationDate: sql`excluded.creation_date`,
            approvedByBankDate: sql`excluded.approved_by_bank_date`,
            completionDate: sql`excluded.completion_date`,
            cancellationReason: sql`excluded.cancellation_reason`,
            creditTerm: sql`excluded.credit_term`,
            syncedAt: sql`excluded.synced_at`,
            // NOTE: entriesCount deliberately NOT overwritten here — it's set
            // below only when we actually replaced the entries.
          },
        })
        .returning({ id: kaspiOrders.id });

      // Only touch entries if we successfully fetched them.
      if (entries !== null) {
        await tx
          .delete(kaspiOrderEntries)
          .where(eq(kaspiOrderEntries.orderId, row.id));
        if (entries.length > 0) {
          await tx
            .insert(kaspiOrderEntries)
            .values(
              entries.map((e, i) => this.toEntryRow(row.id, seller.id, e, i)),
            );
        }
        await tx
          .update(kaspiOrders)
          .set({ entriesCount: entries.length })
          .where(eq(kaspiOrders.id, row.id));
      }
    });
  }

  /**
   * Headers of the orders we already store, by code. Chunked so a long
   * backfill does not build one enormous `IN (…)`.
   */
  private async storedOrders(
    sellerId: string,
    codes: string[],
  ): Promise<Map<string, StoredOrderHead>> {
    const out = new Map<string, StoredOrderHead>();
    for (let i = 0; i < codes.length; i += ORDER_LOOKUP_CHUNK) {
      const rows = await this.db
        .select({
          code: kaspiOrders.code,
          state: kaspiOrders.state,
          status: kaspiOrders.status,
          totalPrice: kaspiOrders.totalPrice,
          entriesCount: kaspiOrders.entriesCount,
        })
        .from(kaspiOrders)
        .where(
          and(
            eq(kaspiOrders.sellerId, sellerId),
            inArray(kaspiOrders.code, codes.slice(i, i + ORDER_LOOKUP_CHUNK)),
          ),
        );
      for (const row of rows) out.set(row.code, row);
    }
    return out;
  }

  /**
   * Do we have to pull this order's line items again?
   *
   * Line items don't move on their own: what changes them — a return, a
   * cancellation, a partial pickup — also moves the header's state, status or
   * total. So an order whose header is unchanged, and whose entries we already
   * hold, can keep them. This is what takes the daily sync from one request
   * per order down to one per order that actually changed.
   *
   * Deliberately pessimistic: unknown order, or `entriesCount = 0` (never
   * stored, or an earlier fetch failed), means fetch.
   */
  private entriesAreStale(
    stored: StoredOrderHead | undefined,
    order: KaspiOrder,
  ): boolean {
    if (!stored || stored.entriesCount === 0) return true;
    const a = order.attributes;
    return (
      stored.state !== a.state ||
      stored.status !== a.status ||
      stored.totalPrice !== Math.round(a.totalPrice ?? 0)
    );
  }

  /** First-login one-time pull: the full 89-day archive window. */
  async backfillOrders(id: string, userId: string) {
    const seller = await this.ownedSeller(id, userId);
    return this.runOrderSync(seller, ORDER_BACKFILL_DAYS);
  }

  /** Manual incremental refresh: the 14-day (return-window) re-pull. */
  async syncOrders(id: string, userId: string) {
    const seller = await this.ownedSeller(id, userId);
    return this.runOrderSync(
      seller,
      await this.orderSyncDays(seller.id, ORDER_INCREMENTAL_DAYS),
    );
  }

  /**
   * Window for a routine order sync: `days`, or the whole backfill window
   * while an order older than that still has no line items (every fetch for
   * it failed — Kaspi or the network dropped mid-sync). Otherwise such an
   * order would leave the 14-day window without line items, and stay out of
   * product stats and cost of goods for good. The wider pull only costs list
   * requests: orders that already have their line items are skipped.
   */
  private async orderSyncDays(sellerId: string, days: number): Promise<number> {
    if (days >= ORDER_BACKFILL_DAYS) return days;
    const now = Date.now();
    const [gap] = await this.db
      .select({ id: kaspiOrders.id })
      .from(kaspiOrders)
      .where(
        and(
          eq(kaspiOrders.sellerId, sellerId),
          eq(kaspiOrders.entriesCount, 0),
          gte(
            kaspiOrders.creationDate,
            new Date(now - ORDER_BACKFILL_DAYS * DAY_MS),
          ),
          lte(kaspiOrders.creationDate, new Date(now - days * DAY_MS)),
        ),
      )
      .limit(1);
    return gap ? ORDER_BACKFILL_DAYS : days;
  }

  /**
   * Live list of currently-active (non-archive) orders — NEW, SIGN_REQUIRED,
   * PICKUP, DELIVERY, KASPI_DELIVERY. Fetched fresh from Kaspi (not stored)
   * since active orders change state constantly.
   */
  async getActiveOrders(id: string, userId: string) {
    const seller = await this.ownedSeller(id, userId);
    const token = this.sellerToken(seller);
    let res: Awaited<ReturnType<typeof fetchActiveOrders>>;
    try {
      res = await fetchActiveOrders(token);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof KaspiAuthError) throw new UnauthorizedException(msg);
      throw e;
    }
    const data = res.orders
      .map((o) => {
        const a = o.attributes;
        const asDate = (ms?: number | null) =>
          typeof ms === 'number' ? new Date(ms) : null;
        return {
          code: a.code,
          state: a.state,
          status: a.status,
          totalPrice: Math.round(a.totalPrice ?? 0),
          deliveryMode: a.deliveryMode ?? null,
          isKaspiDelivery: a.isKaspiDelivery ?? false,
          customerName: a.customer?.name ?? null,
          plannedDeliveryDate: asDate(a.plannedDeliveryDate),
          creationDate: asDate(a.creationDate),
        };
      })
      .sort(
        (x, y) =>
          (y.creationDate?.getTime() ?? 0) - (x.creationDate?.getTime() ?? 0),
      );
    return { totalActive: data.length, byState: res.byState, data };
  }

  /** Daily cron entrypoint: 14-day incremental for every API-token seller. */
  async syncAllOrdersDue(sinceDays = ORDER_INCREMENTAL_DAYS) {
    if (this.syncingOrders) {
      this.logger.warn('Order auto-sync skipped: previous run still running');
      return;
    }
    this.syncingOrders = true;
    try {
      const due = await this.db
        .select()
        .from(sellers)
        .where(isNotNull(sellers.kaspiApiTokenEnc));
      this.logger.log(`Order auto-sync: ${due.length} seller(s) due`);
      await runPool(due, SELLER_SYNC_CONCURRENCY, async (seller) => {
        try {
          const r = await this.runOrderSync(
            seller,
            await this.orderSyncDays(seller.id, sinceDays),
          );
          this.logger.log(
            `Order auto-sync ${seller.id}: ${r.orders} orders, ${r.entries} entries`,
          );
        } catch (e) {
          this.logger.warn(
            `Order auto-sync ${seller.id} failed: ${
              e instanceof Error ? e.message : e
            }`,
          );
        }
      });
    } finally {
      this.syncingOrders = false;
    }
  }

  async listOrders(id: string, userId: string, q: ListOrdersQueryDto) {
    await this.ownedSeller(id, userId);

    const conds = [eq(kaspiOrders.sellerId, id)];
    if (q.status) conds.push(eq(kaspiOrders.status, q.status));
    if (q.dateFrom) {
      conds.push(gte(kaspiOrders.creationDate, new Date(q.dateFrom)));
    }
    if (q.dateTo) {
      conds.push(lte(kaspiOrders.creationDate, new Date(q.dateTo)));
    }
    const where = and(...conds);

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(kaspiOrders)
      .where(where);

    const data = await this.db
      .select({
        code: kaspiOrders.code,
        state: kaspiOrders.state,
        status: kaspiOrders.status,
        totalPrice: kaspiOrders.totalPrice,
        deliveryCostForSeller: kaspiOrders.deliveryCostForSeller,
        paymentMode: kaspiOrders.paymentMode,
        deliveryMode: kaspiOrders.deliveryMode,
        isKaspiDelivery: kaspiOrders.isKaspiDelivery,
        customerName: kaspiOrders.customerName,
        deliveryTown: kaspiOrders.deliveryTown,
        entriesCount: kaspiOrders.entriesCount,
        creationDate: kaspiOrders.creationDate,
        completionDate: kaspiOrders.completionDate,
      })
      .from(kaspiOrders)
      .where(where)
      .orderBy(desc(kaspiOrders.creationDate))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);

    return { total, page: q.page, limit: q.limit, data };
  }

  /**
   * User-supplied COGS for a single product. Survives Kaspi syncs.
   *
   * Пишет не напрямую в `cost_price`, а через историю себестоимости
   * (AnalyticsService): правка из таблицы «Настроек» и правка из карточки
   * товара обязаны попадать в один и тот же журнал, иначе «ИСТОРИЯ
   * СЕБЕСТОИМОСТИ» будет знать только про половину изменений.
   */
  async updateCostPrice(
    sellerId: string,
    userId: string,
    sku: string,
    costPrice: number | null,
  ) {
    await this.ownedSeller(sellerId, userId);
    const [exists] = await this.db
      .select({ sku: kaspiProducts.sku })
      .from(kaspiProducts)
      .where(
        and(eq(kaspiProducts.sellerId, sellerId), eq(kaspiProducts.sku, sku)),
      )
      .limit(1);
    if (!exists) {
      throw new NotFoundException(`Product ${sku} not found for this seller`);
    }

    if (costPrice == null) await this.analytics.clearCost(sellerId, sku);
    else await this.analytics.recordCost(sellerId, sku, costPrice);

    const [row] = await this.db
      .select({
        sku: kaspiProducts.sku,
        title: kaspiProducts.title,
        priceMin: kaspiProducts.priceMin,
        costPrice: kaspiProducts.costPrice,
      })
      .from(kaspiProducts)
      .where(
        and(eq(kaspiProducts.sellerId, sellerId), eq(kaspiProducts.sku, sku)),
      )
      .limit(1);
    return row;
  }

  async listProducts(id: string, userId: string, q: ListProductsQueryDto) {
    await this.ownedSeller(id, userId);

    const conds = [eq(kaspiProducts.sellerId, id)];
    if (q.search) {
      conds.push(
        or(
          ilike(kaspiProducts.title, `%${q.search}%`),
          ilike(kaspiProducts.sku, `%${q.search}%`),
        )!,
      );
    }
    if (q.available === 'true' || q.available === 'false') {
      conds.push(eq(kaspiProducts.available, q.available === 'true'));
    }
    // Hide archived rows by default; `?archived=true` returns active+archived.
    if (q.archived !== 'true') {
      conds.push(isNull(kaspiProducts.archivedAt));
    }
    const where = and(...conds);

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(kaspiProducts)
      .where(where);

    const data = await this.db
      .select({
        sku: kaspiProducts.sku,
        title: kaspiProducts.title,
        brand: kaspiProducts.brand,
        masterCategory: kaspiProducts.masterCategory,
        priceMin: kaspiProducts.priceMin,
        priceMax: kaspiProducts.priceMax,
        costPrice: kaspiProducts.costPrice,
        available: kaspiProducts.available,
        totalStock: kaspiProducts.totalStock,
        availabilities: kaspiProducts.availabilities,
        archivedAt: kaspiProducts.archivedAt,
        kaspiUpdatedAt: kaspiProducts.kaspiUpdatedAt,
        syncedAt: kaspiProducts.syncedAt,
      })
      .from(kaspiProducts)
      .where(where)
      .orderBy(kaspiProducts.title)
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);

    return { total, page: q.page, limit: q.limit, data };
  }
}
