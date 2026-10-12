import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import {
  kaspiOrders,
  kaspiProducts,
  sellers,
  unitEconomicsCalculations,
  users,
} from '../database/schema';
import { LegalService } from '../legal/legal.service';
import {
  AdminSellersQueryDto,
  AdminUsersQueryDto,
  UpdatePlanDto,
} from './dto/admin.dto';

/** Cross-tenant read/aggregation for the internal admin panel. */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly legal: LegalService,
  ) {}

  /** «Overview» KPIs across the whole platform. */
  async overview() {
    const d7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const d30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

    const [u] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        new7d: sql<number>`count(*) filter (where ${users.createdAt} >= ${d7})::int`,
        new30d: sql<number>`count(*) filter (where ${users.createdAt} >= ${d30})::int`,
        free: sql<number>`count(*) filter (where ${users.plan} = 'free')::int`,
        pro: sql<number>`count(*) filter (where ${users.plan} = 'pro')::int`,
        admins: sql<number>`count(*) filter (where ${users.role} = 'admin')::int`,
      })
      .from(users);

    const [s] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        needsReauth: sql<number>`count(*) filter (where ${sellers.cookieStatus} = 'needs_reauth')::int`,
        withErrors: sql<number>`count(*) filter (where ${sellers.lastSyncError} is not null)::int`,
      })
      .from(sellers);

    const [o] = await this.db
      .select({
        orders: sql<number>`count(*)::int`,
        gmv: sql<string>`coalesce(sum(${kaspiOrders.totalPrice}) filter (where ${kaspiOrders.status} = 'COMPLETED'), 0)::bigint`,
      })
      .from(kaspiOrders);

    const [p] = await this.db
      .select({ products: sql<number>`count(*)::int` })
      .from(kaspiProducts);

    const [c] = await this.db
      .select({ calcs: sql<number>`count(*)::int` })
      .from(unitEconomicsCalculations);

    return {
      users: {
        total: u.total,
        new7d: u.new7d,
        new30d: u.new30d,
        free: u.free,
        pro: u.pro,
        admins: u.admins,
      },
      sellers: {
        total: s.total,
        needsReauth: s.needsReauth,
        withErrors: s.withErrors,
        ok: s.total - s.needsReauth,
      },
      data: {
        orders: o.orders,
        products: p.products,
        gmvCompleted: Number(o.gmv),
        unitEconomicsCalcs: c.calcs,
      },
    };
  }

  async listUsers(q: AdminUsersQueryDto) {
    const conds = [];
    if (q.search) {
      conds.push(
        or(
          ilike(users.email, `%${q.search}%`),
          ilike(users.name, `%${q.search}%`),
        ),
      );
    }
    if (q.plan) conds.push(eq(users.plan, q.plan));
    const where = conds.length ? and(...conds) : undefined;

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(users)
      .where(where);

    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        plan: users.plan,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);

    // Seller counts for this page, one grouped query, merged in JS.
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await this.db
          .select({ userId: sellers.userId, n: count() })
          .from(sellers)
          .where(inArray(sellers.userId, ids))
          .groupBy(sellers.userId)
      : [];
    const byUser = new Map(counts.map((c) => [c.userId, Number(c.n)]));
    const data = rows.map((r) => ({
      ...r,
      sellerCount: byUser.get(r.id) ?? 0,
    }));

    return { total, page: q.page, limit: q.limit, data };
  }

  /** One user + their sellers + usage counts + accepted legal documents. */
  async getUser(id: string) {
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        plan: users.plan,
        planExpiresAt: users.planExpiresAt,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) throw new NotFoundException('User not found');

    const sellerRows = await this.db
      .select({
        id: sellers.id,
        name: sellers.name,
        kaspiMerchantUid: sellers.kaspiMerchantUid,
        cookieStatus: sellers.cookieStatus,
        lastSyncAt: sellers.lastSyncAt,
        lastSyncError: sellers.lastSyncError,
        createdAt: sellers.createdAt,
      })
      .from(sellers)
      .where(eq(sellers.userId, id))
      .orderBy(desc(sellers.createdAt));

    const sids = sellerRows.map((s) => s.id);
    const orderCounts = sids.length
      ? await this.db
          .select({ sellerId: kaspiOrders.sellerId, n: count() })
          .from(kaspiOrders)
          .where(inArray(kaspiOrders.sellerId, sids))
          .groupBy(kaspiOrders.sellerId)
      : [];
    const productCounts = sids.length
      ? await this.db
          .select({ sellerId: kaspiProducts.sellerId, n: count() })
          .from(kaspiProducts)
          .where(inArray(kaspiProducts.sellerId, sids))
          .groupBy(kaspiProducts.sellerId)
      : [];
    const oc = new Map(orderCounts.map((r) => [r.sellerId, Number(r.n)]));
    const pc = new Map(productCounts.map((r) => [r.sellerId, Number(r.n)]));

    const sellersList = sellerRows.map((s) => ({
      ...s,
      orders: oc.get(s.id) ?? 0,
      products: pc.get(s.id) ?? 0,
    }));

    const [calcs] = await this.db
      .select({ value: count() })
      .from(unitEconomicsCalculations)
      .where(eq(unitEconomicsCalculations.userId, id));

    // What this user accepted, for support and legal requests. Accounts created
    // before consent was collected have none.
    const consents = await this.legal.consentsOf(id);

    return {
      ...user,
      sellers: sellersList,
      usage: { sellers: sellersList.length, unitEconomicsCalcs: calcs.value },
      consents,
    };
  }

  /**
   * A plan set by hand has no end date: Pro granted here stays until changed
   * here, and Free drops whatever paid period was left.
   */
  async setPlan(id: string, dto: UpdatePlanDto) {
    const [row] = await this.db
      .update(users)
      .set({ plan: dto.plan, planExpiresAt: null, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning({
        id: users.id,
        email: users.email,
        plan: users.plan,
        role: users.role,
      });
    if (!row) throw new NotFoundException('User not found');
    return row;
  }

  /** Seller health board across all users. */
  async listSellers(q: AdminSellersQueryDto) {
    const where = q.status ? eq(sellers.cookieStatus, q.status) : undefined;

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(sellers)
      .where(where);

    const rows = await this.db
      .select({
        id: sellers.id,
        name: sellers.name,
        kaspiMerchantUid: sellers.kaspiMerchantUid,
        cookieStatus: sellers.cookieStatus,
        lastSyncAt: sellers.lastSyncAt,
        lastSyncError: sellers.lastSyncError,
        ownerId: users.id,
        ownerEmail: users.email,
      })
      .from(sellers)
      .leftJoin(users, eq(users.id, sellers.userId))
      .where(where)
      .orderBy(desc(sellers.lastSyncAt))
      .limit(q.limit)
      .offset((q.page - 1) * q.limit);

    const sids = rows.map((r) => r.id);
    const orderCounts = sids.length
      ? await this.db
          .select({ sellerId: kaspiOrders.sellerId, n: count() })
          .from(kaspiOrders)
          .where(inArray(kaspiOrders.sellerId, sids))
          .groupBy(kaspiOrders.sellerId)
      : [];
    const oc = new Map(orderCounts.map((r) => [r.sellerId, Number(r.n)]));
    const data = rows.map((r) => ({ ...r, orders: oc.get(r.id) ?? 0 }));

    return { total, page: q.page, limit: q.limit, data };
  }
}
