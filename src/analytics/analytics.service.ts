import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import {
  kaspiOrderEntries,
  kaspiOrders,
  kaspiProducts,
  productCostHistory,
  productPriceHistory,
  type SellerExpenseCategoryRow,
  type SellerSettingsRow,
  sellerExpenseCategories,
  sellerSettings,
  sellers,
} from '../database/schema';
import { BulkCostDto, BulkCostPercentDto } from './dto/bulk-cost.dto';
import {
  CreateExpenseCategoryDto,
  UpdateExpenseCategoryDto,
} from './dto/expense-category.dto';
import { ProductStatsQueryDto } from './dto/product-stats-query.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * Seeded when a seller first opens the analytics settings.
 * NB: delivery is NOT a category — it comes real from each order
 * (`deliveryCostForSeller`). Returns are computed from the orders, not a flat %.
 * Both were dropped to avoid double-counting.
 */
const DEFAULT_CATEGORIES = [
  { name: 'Комиссия Kaspi', kind: 'percent', value: '15', color: '#6C5CE7' },
  { name: 'Упаковка', kind: 'fixed', value: '150', color: '#22C55E' },
] as const;

/**
 * Единые пороги «слабого» товара. Одна и та же позиция попадает в карточку
 * товара, в фильтр «Слабые» и в подборку проблемных для AI — считать порог в
 * каждом месте заново значит однажды показать «Прибыльный» в попапе над
 * строкой, подсвеченной в таблице красным.
 */
export const LOW_MARGIN_PCT = 10;
export const HIGH_RETURNS_PCT = 5;

export type ProductStatus = 'profitable' | 'low_margin' | 'loss';
export type ReturnsLevel = 'normal' | 'high';

/**
 * Себестоимость, применяемая к позиции заказа. Работает вместе с
 * `costAtOrderDateJoins()` — псевдонимы джойнов оттуда.
 */
const EFFECTIVE_COST = sql`COALESCE(at_date.cost, earliest.cost, p.cost_price)`;

/** Бейдж товара: «Прибыльный» / «низкая маржа» / «убыток». */
export function productStatus(
  profit: number,
  marginPct: number,
): ProductStatus {
  if (profit < 0) return 'loss';
  if (marginPct < LOW_MARGIN_PCT) return 'low_margin';
  return 'profitable';
}

@Injectable()
export class AnalyticsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** Enforce that the seller exists and belongs to the user. */
  private async assertOwned(sellerId: string, userId: string): Promise<void> {
    const [seller] = await this.db
      .select({ id: sellers.id, userId: sellers.userId })
      .from(sellers)
      .where(eq(sellers.id, sellerId))
      .limit(1);
    if (!seller) throw new NotFoundException(`Seller ${sellerId} not found`);
    if (seller.userId !== userId) {
      throw new ForbiddenException('Not your seller');
    }
  }

  private settingsView(row: SellerSettingsRow) {
    return {
      applyExpensesAuto: row.applyExpensesAuto,
      taxPercent: Number(row.taxPercent),
      goals: {
        targetProfitPct: Number(row.targetProfitPct),
        minProfitPct: Number(row.minProfitPct),
        paybackMonths: row.paybackMonths,
      },
      updatedAt: row.updatedAt,
    };
  }

  private categoryView(row: SellerExpenseCategoryRow) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      value: Number(row.value),
      color: row.color,
      sortOrder: row.sortOrder,
    };
  }

  /** Create the settings row (+ default categories) on first access. */
  private async ensureSeeded(sellerId: string): Promise<SellerSettingsRow> {
    const [row] = await this.db
      .insert(sellerSettings)
      .values({ sellerId })
      .onConflictDoNothing()
      .returning();
    if (row) {
      // Brand-new settings row → seed the default expense categories.
      await this.db.insert(sellerExpenseCategories).values(
        DEFAULT_CATEGORIES.map((c, i) => ({
          sellerId,
          name: c.name,
          kind: c.kind,
          value: c.value,
          color: c.color,
          sortOrder: i,
        })),
      );
      return row;
    }
    const [existing] = await this.db
      .select()
      .from(sellerSettings)
      .where(eq(sellerSettings.sellerId, sellerId))
      .limit(1);
    return existing;
  }

  private listCategories(sellerId: string) {
    return this.db
      .select()
      .from(sellerExpenseCategories)
      .where(eq(sellerExpenseCategories.sellerId, sellerId))
      .orderBy(asc(sellerExpenseCategories.sortOrder));
  }

  /** Full settings payload for the Settings screen. */
  async getSettings(sellerId: string, userId: string) {
    await this.assertOwned(sellerId, userId);
    const settings = await this.ensureSeeded(sellerId);
    const categories = await this.listCategories(sellerId);
    return {
      ...this.settingsView(settings),
      expenseCategories: categories.map((c) => this.categoryView(c)),
    };
  }

  async updateSettings(
    sellerId: string,
    userId: string,
    dto: UpdateSettingsDto,
  ) {
    await this.assertOwned(sellerId, userId);
    await this.ensureSeeded(sellerId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.applyExpensesAuto !== undefined)
      patch.applyExpensesAuto = dto.applyExpensesAuto;
    if (dto.targetProfitPct !== undefined)
      patch.targetProfitPct = String(dto.targetProfitPct);
    if (dto.minProfitPct !== undefined)
      patch.minProfitPct = String(dto.minProfitPct);
    if (dto.taxPercent !== undefined) patch.taxPercent = String(dto.taxPercent);
    if (dto.paybackMonths !== undefined)
      patch.paybackMonths = dto.paybackMonths;

    const [row] = await this.db
      .update(sellerSettings)
      .set(patch)
      .where(eq(sellerSettings.sellerId, sellerId))
      .returning();
    // Same shape as GET. The Settings page replaces its state with this
    // response, and without `expenseCategories` its next render read
    // `undefined.length` and blanked the whole app.
    const categories = await this.listCategories(sellerId);
    return {
      ...this.settingsView(row),
      expenseCategories: categories.map((c) => this.categoryView(c)),
    };
  }

  async listExpenseCategories(sellerId: string, userId: string) {
    await this.assertOwned(sellerId, userId);
    await this.ensureSeeded(sellerId);
    const cats = await this.listCategories(sellerId);
    return cats.map((c) => this.categoryView(c));
  }

  async addExpenseCategory(
    sellerId: string,
    userId: string,
    dto: CreateExpenseCategoryDto,
  ) {
    await this.assertOwned(sellerId, userId);
    await this.ensureSeeded(sellerId);
    // New category sorts to the end.
    const existing = await this.listCategories(sellerId);
    const [row] = await this.db
      .insert(sellerExpenseCategories)
      .values({
        sellerId,
        name: dto.name,
        kind: dto.kind,
        value: String(dto.value),
        color: dto.color ?? null,
        sortOrder: existing.length,
      })
      .returning();
    return this.categoryView(row);
  }

  async updateExpenseCategory(
    sellerId: string,
    userId: string,
    categoryId: string,
    dto: UpdateExpenseCategoryDto,
  ) {
    await this.assertOwned(sellerId, userId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.value !== undefined) patch.value = String(dto.value);
    if (dto.color !== undefined) patch.color = dto.color;

    const [row] = await this.db
      .update(sellerExpenseCategories)
      .set(patch)
      .where(
        and(
          eq(sellerExpenseCategories.id, categoryId),
          eq(sellerExpenseCategories.sellerId, sellerId),
        ),
      )
      .returning();
    if (!row) {
      throw new NotFoundException('Expense category not found for this seller');
    }
    return this.categoryView(row);
  }

  async deleteExpenseCategory(
    sellerId: string,
    userId: string,
    categoryId: string,
  ) {
    await this.assertOwned(sellerId, userId);
    const [row] = await this.db
      .delete(sellerExpenseCategories)
      .where(
        and(
          eq(sellerExpenseCategories.id, categoryId),
          eq(sellerExpenseCategories.sellerId, sellerId),
        ),
      )
      .returning({ id: sellerExpenseCategories.id });
    if (!row) {
      throw new NotFoundException('Expense category not found for this seller');
    }
    return { deleted: true, id: row.id };
  }

  /** «Быстрый старт» — bulk-apply one cost price to products. */
  async bulkApplyCost(sellerId: string, userId: string, dto: BulkCostDto) {
    await this.assertOwned(sellerId, userId);
    const onlyUnfilled = dto.onlyUnfilled ?? true;
    const where = onlyUnfilled
      ? and(
          eq(kaspiProducts.sellerId, sellerId),
          isNull(kaspiProducts.costPrice),
        )
      : eq(kaspiProducts.sellerId, sellerId);
    const before = await this.costsBefore(where);
    const updated = await this.db
      .update(kaspiProducts)
      .set({ costPrice: dto.cost })
      .where(where)
      .returning({
        sku: kaspiProducts.sku,
        costPrice: kaspiProducts.costPrice,
      });
    const recorded = await this.recordCostBulk(sellerId, before, updated);
    return { updated: updated.length, costHistoryPoints: recorded };
  }

  /**
   * Set each product's cost to `percent`% of its OWN sale price (priceMin).
   * Rounded to whole tenge. `onlyUnfilled` (default false) protects products
   * that already have a cost.
   */
  async bulkApplyCostPercent(
    sellerId: string,
    userId: string,
    dto: BulkCostPercentDto,
  ) {
    await this.assertOwned(sellerId, userId);
    const onlyUnfilled = dto.onlyUnfilled ?? false;
    const where = onlyUnfilled
      ? and(
          eq(kaspiProducts.sellerId, sellerId),
          isNull(kaspiProducts.costPrice),
        )
      : eq(kaspiProducts.sellerId, sellerId);
    const before = await this.costsBefore(where);
    const updated = await this.db
      .update(kaspiProducts)
      .set({
        // cost = round(price_min * percent / 100), per product.
        costPrice: sql`round(${kaspiProducts.priceMin} * ${dto.percent} / 100.0)::int`,
      })
      .where(where)
      .returning({
        sku: kaspiProducts.sku,
        costPrice: kaspiProducts.costPrice,
      });
    const recorded = await this.recordCostBulk(sellerId, before, updated);
    return {
      updated: updated.length,
      percent: dto.percent,
      costHistoryPoints: recorded,
    };
  }

  /** Себестоимости до массовой правки — чтобы понять, что реально изменилось. */
  private async costsBefore(where: ReturnType<typeof eq> | undefined) {
    const rows = await this.db
      .select({ sku: kaspiProducts.sku, costPrice: kaspiProducts.costPrice })
      .from(kaspiProducts)
      .where(where);
    return new Map(rows.map((r) => [r.sku, r.costPrice]));
  }

  /**
   * Засечки в историю себестоимости после массовой правки.
   *
   * Массовые операции пишут `cost_price` напрямую, и без этого «ИСТОРИЯ
   * СЕБЕСТОИМОСТИ» в карточке молчала бы о «Быстром старте» — хотя именно он
   * и заполнил закупку большинству товаров.
   *
   * Пишем только там, где значение действительно изменилось: повторное
   * «Применить» с тем же процентом иначе добавляло бы сотни одинаковых строк.
   */
  private async recordCostBulk(
    sellerId: string,
    before: Map<string, number | null>,
    updated: Array<{ sku: string; costPrice: number | null }>,
  ): Promise<number> {
    const effectiveFrom = new Date();
    const changed = updated.filter(
      (u) => u.costPrice != null && before.get(u.sku) !== u.costPrice,
    );
    if (changed.length === 0) return 0;
    for (let i = 0; i < changed.length; i += 200) {
      const chunk = changed.slice(i, i + 200);
      await this.db
        .insert(productCostHistory)
        .values(
          chunk.map((u) => ({
            sellerId,
            sku: u.sku,
            cost: u.costPrice as number,
            effectiveFrom,
          })),
        )
        .onConflictDoUpdate({
          target: [
            productCostHistory.sellerId,
            productCostHistory.sku,
            productCostHistory.effectiveFrom,
          ],
          set: { cost: sql`excluded.cost` },
        });
    }
    return changed.length;
  }

  // --- Profit & expenses («Прибыль и расходы») -----------------------------

  private periodDays(period: string): number {
    const map: Record<string, number> = {
      '7d': 7,
      '30d': 30,
      '90d': 90,
      '12m': 365,
    };
    return map[period] ?? 30;
  }

  /**
   * Real per-period aggregates from the orders. Revenue/delivery come from the
   * orders (COMPLETED only); units/COGS from the line items joined to product
   * cost (entry.offer_code = product.sku). Money is summed in exact integers.
   */
  private async orderTotals(sellerId: string, from: Date, to: Date) {
    const inPeriod = and(
      eq(kaspiOrders.sellerId, sellerId),
      eq(kaspiOrders.status, 'COMPLETED'),
      gte(kaspiOrders.creationDate, from),
      lte(kaspiOrders.creationDate, to),
    );
    const [ord] = await this.db
      .select({
        revenue: sql<string>`coalesce(sum(${kaspiOrders.totalPrice}), 0)`,
        delivery: sql<string>`coalesce(sum(${kaspiOrders.deliveryCostForSeller}), 0)`,
        orders: sql<string>`count(*)`,
      })
      .from(kaspiOrders)
      .where(inPeriod);
    // COGS считается по себестоимости НА ДАТУ ЗАКАЗА — см. costAtOrderDateJoins.
    const [ent] = (await this.db.execute(sql`
      WITH ent AS (
        SELECT e.offer_code, e.quantity, o.creation_date AS order_date
          FROM kaspi_order_entries e
          JOIN kaspi_orders o ON o.id = e.order_id
         WHERE o.seller_id = ${sellerId} AND o.status = 'COMPLETED'
           AND o.creation_date >= ${from.toISOString()}
           AND o.creation_date <= ${to.toISOString()}
      ), priced AS (
        SELECT ent.quantity, ${EFFECTIVE_COST} AS eff_cost
          FROM ent
          ${this.costAtOrderDateJoins(sellerId)}
      )
      SELECT COALESCE(SUM(quantity), 0)::int AS units,
             COALESCE(SUM(quantity * COALESCE(eff_cost, 0)), 0)::bigint AS cogs,
             COALESCE(SUM(CASE WHEN eff_cost IS NULL THEN quantity ELSE 0 END), 0)::int
               AS missing_cost_units
        FROM priced
    `)) as unknown as Array<Record<string, unknown>>;
    return {
      revenue: Number(ord.revenue),
      delivery: Number(ord.delivery),
      orders: Number(ord.orders),
      units: Number(ent.units),
      cogs: Number(ent.cogs),
      missingCostUnits: Number(ent.missing_cost_units),
    };
  }

  /**
   * Джойны для себестоимости, действовавшей НА ДАТУ КАЖДОГО ЗАКАЗА. Ожидают
   * CTE `ent` с колонками `offer_code` и `order_date`.
   *
   * Порядок выбора (см. EFFECTIVE_COST):
   *  1) последняя запись истории, начавшая действовать не позже даты заказа;
   *  2) если заказ старше всей истории — самая ранняя запись;
   *  3) если истории по товару нет вовсе — текущий cost_price из карточки.
   * Третий шаг и есть страховка: пока история не засеяна, COGS считается
   * ровно так, как считался раньше.
   *
   * Живёт одним фрагментом на оба запроса: две копии формулы COGS однажды
   * разъедутся, и «Прибыль и расходы» перестанет сходиться с «Товарами».
   */
  private costAtOrderDateJoins(sellerId: string) {
    return sql`
      LEFT JOIN kaspi_products p
             ON p.seller_id = ${sellerId} AND p.sku = ent.offer_code
      LEFT JOIN LATERAL (
        SELECT h.cost FROM product_cost_history h
         WHERE h.seller_id = ${sellerId} AND h.sku = ent.offer_code
           AND h.effective_from <= ent.order_date
         ORDER BY h.effective_from DESC LIMIT 1
      ) at_date ON TRUE
      LEFT JOIN LATERAL (
        SELECT h.cost FROM product_cost_history h
         WHERE h.seller_id = ${sellerId} AND h.sku = ent.offer_code
         ORDER BY h.effective_from ASC LIMIT 1
      ) earliest ON TRUE`;
  }

  /** Expense lines for a period: user categories + real delivery + tax. */
  private expenseLines(
    categories: SellerExpenseCategoryRow[],
    taxPercent: number,
    totals: { revenue: number; units: number; delivery: number },
  ) {
    // `kind` отделяет статьи, которые двигаются сами (реальная доставка), от
    // тех, что наши формулы жёстко привязали к выручке или к штукам. На это
    // опирается AI: доля процентной статьи не может «раздуться» по построению.
    const lines: Array<{
      key: string;
      label: string;
      color: string | null;
      amount: number;
      kind: 'percent' | 'fixed' | 'delivery' | 'tax';
    }> = categories.map((c) => ({
      key: `category:${c.id}`,
      label: c.name,
      color: c.color,
      amount: Math.round(
        c.kind === 'percent'
          ? (Number(c.value) / 100) * totals.revenue
          : Number(c.value) * totals.units,
      ),
      kind: c.kind === 'percent' ? 'percent' : 'fixed',
    }));
    // Delivery is REAL (from Kaspi), never a category.
    lines.push({
      key: 'delivery',
      label: 'Доставка',
      color: '#10B981',
      amount: Math.round(totals.delivery),
      kind: 'delivery',
    });
    if (taxPercent > 0) {
      lines.push({
        key: 'tax',
        label: 'Налоги',
        color: '#6B7280',
        amount: Math.round((taxPercent / 100) * totals.revenue),
        kind: 'tax',
      });
    }
    return lines;
  }

  private pctDelta(cur: number, prev: number): number | null {
    if (prev <= 0) return null;
    return +(((cur - prev) / prev) * 100).toFixed(1);
  }

  /** The «Прибыль и расходы» dashboard payload for a period. */
  async getProfitSummary(sellerId: string, userId: string, period: string) {
    await this.assertOwned(sellerId, userId);
    const settings = await this.ensureSeeded(sellerId);
    const categories = await this.listCategories(sellerId);
    const taxPercent = Number(settings.taxPercent);

    const days = this.periodDays(period);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const prevTo = from;
    const prevFrom = new Date(from.getTime() - days * 86_400_000);

    const cur = await this.orderTotals(sellerId, from, to);
    const prev = await this.orderTotals(sellerId, prevFrom, prevTo);

    const curLines = this.expenseLines(categories, taxPercent, cur);
    const prevLines = this.expenseLines(categories, taxPercent, prev);
    const opex = curLines.reduce((s, l) => s + l.amount, 0);
    const prevOpex = prevLines.reduce((s, l) => s + l.amount, 0);
    const netProfit = cur.revenue - cur.cogs - opex;
    const prevProfit = prev.revenue - prev.cogs - prevOpex;

    // Статья «раздувается» не сама по себе, а относительно оборота — для этого
    // нужны и её доля в выручке, и её собственный рост к прошлому периоду.
    const prevByKey = new Map(prevLines.map((l) => [l.key, l.amount]));
    const byCategory = curLines
      .map((l) => ({
        ...l,
        share: opex > 0 ? +((l.amount / opex) * 100).toFixed(1) : 0,
        shareOfRevenuePct:
          cur.revenue > 0 ? +((l.amount / cur.revenue) * 100).toFixed(1) : 0,
        changePct: this.pctDelta(l.amount, prevByKey.get(l.key) ?? 0),
      }))
      .sort((a, b) => b.amount - a.amount);

    return {
      period,
      from,
      to,
      revenue: cur.revenue,
      cogs: cur.cogs,
      operatingExpenses: opex,
      netProfit,
      marginPct:
        cur.revenue > 0 ? +((netProfit / cur.revenue) * 100).toFixed(1) : 0,
      expensesShareOfRevenuePct:
        cur.revenue > 0 ? +((opex / cur.revenue) * 100).toFixed(1) : 0,
      orders: cur.orders,
      unitsSold: cur.units,
      // «Из чего состоит выручка»
      composition: { netProfit, cogs: cur.cogs, operatingExpenses: opex },
      // «Расходы по статьям»
      expensesByCategory: byCategory,
      comparison: {
        revenuePct: this.pctDelta(cur.revenue, prev.revenue),
        netProfitPct: this.pctDelta(netProfit, prevProfit),
        expensesPct: this.pctDelta(opex, prevOpex),
      },
      dataQuality: {
        unitsMissingCost: cur.missingCostUnits,
        costCoveragePct:
          cur.units > 0
            ? +((1 - cur.missingCostUnits / cur.units) * 100).toFixed(1)
            : 100,
      },
    };
  }

  /** «Выручка и прибыль по месяцам» — last `months` months. */
  async getMonthly(sellerId: string, userId: string, months: number) {
    await this.assertOwned(sellerId, userId);
    const settings = await this.ensureSeeded(sellerId);
    const categories = await this.listCategories(sellerId);
    const taxPercent = Number(settings.taxPercent);

    // Start at the first day of the earliest month in range.
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1),
    );
    const inRange = and(
      eq(kaspiOrders.sellerId, sellerId),
      eq(kaspiOrders.status, 'COMPLETED'),
      gte(kaspiOrders.creationDate, start),
    );
    const monthExpr = sql<string>`to_char(date_trunc('month', ${kaspiOrders.creationDate}), 'YYYY-MM')`;

    // Two grouped queries so joining line items never inflates order revenue.
    const ordRows = await this.db
      .select({
        month: monthExpr,
        revenue: sql<string>`coalesce(sum(${kaspiOrders.totalPrice}), 0)`,
        delivery: sql<string>`coalesce(sum(${kaspiOrders.deliveryCostForSeller}), 0)`,
      })
      .from(kaspiOrders)
      .where(inRange)
      .groupBy(monthExpr);
    const entRows = await this.db
      .select({
        month: monthExpr,
        units: sql<string>`coalesce(sum(${kaspiOrderEntries.quantity}), 0)`,
        cogs: sql<string>`coalesce(sum(${kaspiOrderEntries.quantity} * coalesce(${kaspiProducts.costPrice}, 0)), 0)`,
      })
      .from(kaspiOrderEntries)
      .innerJoin(kaspiOrders, eq(kaspiOrders.id, kaspiOrderEntries.orderId))
      .leftJoin(
        kaspiProducts,
        and(
          eq(kaspiProducts.sellerId, sellerId),
          eq(kaspiProducts.sku, kaspiOrderEntries.offerCode),
        ),
      )
      .where(inRange)
      .groupBy(monthExpr);

    const ordByMonth = new Map(ordRows.map((r) => [r.month, r]));
    const entByMonth = new Map(entRows.map((r) => [r.month, r]));

    // Emit every month in the window (zero-filled) for a clean chart.
    const out: Array<{
      month: string;
      revenue: number;
      cogs: number;
      operatingExpenses: number;
      profit: number;
    }> = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1) + i, 1),
      );
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const o = ordByMonth.get(key);
      const e = entByMonth.get(key);
      const revenue = Number(o?.revenue ?? 0);
      const delivery = Number(o?.delivery ?? 0);
      const units = Number(e?.units ?? 0);
      const cogs = Number(e?.cogs ?? 0);
      const opex = this.expenseLines(categories, taxPercent, {
        revenue,
        units,
        delivery,
      }).reduce((s, l) => s + l.amount, 0);
      out.push({
        month: key,
        revenue,
        cogs,
        operatingExpenses: opex,
        profit: revenue - cogs - opex,
      });
    }
    return { months, data: out };
  }

  /**
   * «Товарная статистика» — per-product sales/profit for a period. Pure read
   * over stored data: 3 indexed aggregation queries (current period, previous
   * period for the trend, and returns). Delivery is allocated to each product
   * by its revenue share within its order; commission/tax/packaging come from
   * settings. Sorted by profit, filterable (all/top/weak), searchable, paged.
   */
  async getProductStats(
    sellerId: string,
    userId: string,
    q: ProductStatsQueryDto,
  ) {
    await this.assertOwned(sellerId, userId);
    const settings = await this.ensureSeeded(sellerId);
    const categories = await this.listCategories(sellerId);

    const percentRate =
      categories
        .filter((c) => c.kind === 'percent')
        .reduce((s, c) => s + Number(c.value), 0) / 100;
    const fixedPerUnit = categories
      .filter((c) => c.kind === 'fixed')
      .reduce((s, c) => s + Number(c.value), 0);
    const taxRate = Number(settings.taxPercent) / 100;

    const days = this.periodDays(q.period);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const prevTo = from;
    const prevFrom = new Date(from.getTime() - days * 86_400_000);
    // postgres.js can't bind Date objects in raw queries — use ISO strings.
    const fromISO = from.toISOString();
    const toISO = to.toISOString();
    const prevFromISO = prevFrom.toISOString();
    const prevToISO = prevTo.toISOString();

    // Current period: units, revenue, COGS, per-order-allocated delivery.
    const cur = (await this.db.execute(sql`
      WITH ent AS (
        SELECT e.offer_code, e.quantity, e.total_price,
               o.creation_date AS order_date,
               o.delivery_cost_for_seller AS dcs,
               SUM(e.total_price) OVER (PARTITION BY e.order_id) AS order_rev
        FROM kaspi_order_entries e
        JOIN kaspi_orders o ON o.id = e.order_id
        WHERE o.seller_id = ${sellerId} AND o.status = 'COMPLETED'
          AND o.creation_date >= ${fromISO} AND o.creation_date <= ${toISO}
      ), priced AS (
        SELECT ent.*, p.title, p.price_min,
               ${EFFECTIVE_COST} AS eff_cost
          FROM ent
          ${this.costAtOrderDateJoins(sellerId)}
      )
      SELECT offer_code AS sku,
             COALESCE(title, offer_code) AS title,
             COALESCE(SUM(quantity),0)::int AS units,
             COALESCE(SUM(total_price),0)::bigint AS revenue,
             COALESCE(SUM(quantity * COALESCE(eff_cost,0)),0)::bigint AS cogs,
             bool_or(eff_cost IS NULL) AS missing_cost,
             COALESCE(SUM(dcs * total_price / NULLIF(order_rev,0)),0)::bigint AS delivery,
             price_min
        FROM priced
       GROUP BY offer_code, title, price_min
    `)) as unknown as Array<Record<string, unknown>>;

    const prev = (await this.db.execute(sql`
      SELECT e.offer_code AS sku, COALESCE(SUM(e.total_price),0)::bigint AS revenue
      FROM kaspi_order_entries e JOIN kaspi_orders o ON o.id = e.order_id
      WHERE o.seller_id = ${sellerId} AND o.status = 'COMPLETED'
        AND o.creation_date >= ${prevFromISO} AND o.creation_date <= ${prevToISO}
      GROUP BY e.offer_code
    `)) as unknown as Array<Record<string, unknown>>;

    const ret = (await this.db.execute(sql`
      SELECT e.offer_code AS sku, COALESCE(SUM(e.quantity),0)::int AS returned_units
      FROM kaspi_order_entries e JOIN kaspi_orders o ON o.id = e.order_id
      WHERE o.seller_id = ${sellerId} AND o.status = 'RETURNED'
        AND o.creation_date >= ${fromISO} AND o.creation_date <= ${toISO}
      GROUP BY e.offer_code
    `)) as unknown as Array<Record<string, unknown>>;

    const prevRev = new Map(prev.map((r) => [r.sku, Number(r.revenue)]));
    const retUnits = new Map(ret.map((r) => [r.sku, Number(r.returned_units)]));

    let rows = cur.map((r) => {
      const units = Number(r.units);
      const revenue = Number(r.revenue);
      const cogs = Number(r.cogs);
      const delivery = Number(r.delivery);
      const expenses =
        revenue * (percentRate + taxRate) + units * fixedPerUnit + delivery;
      const profit = Math.round(revenue - cogs - expenses);
      const pRev = prevRev.get(r.sku) ?? 0;
      const returned = retUnits.get(r.sku) ?? 0;
      const marginPct =
        revenue > 0 ? +((profit / revenue) * 100).toFixed(1) : 0;
      const returnsPct =
        units + returned > 0
          ? +((returned / (units + returned)) * 100).toFixed(1)
          : 0;
      // Две РАЗНЫЕ цены, обе нужны в карточке товара:
      // listedPrice — цена на Kaspi прямо сейчас (перезаписывается каждым
      // синком), unitPrice — по какой на самом деле покупали в этом периоде.
      // У ~10% позиций они расходятся: цену меняли, была акция, или в периоде
      // было несколько разных цен.
      const listedPrice = r.price_min == null ? null : Number(r.price_min);
      const unitPrice = units > 0 ? Math.round(revenue / units) : 0;
      return {
        sku: r.sku as string,
        title: r.title as string,
        units,
        revenue,
        profit,
        marginPct,
        returnsPct,
        trendPct:
          pRev > 0 ? +(((revenue - pRev) / pRev) * 100).toFixed(0) : null,
        costMissing: r.missing_cost === true,
        profitSharePct: 0, // filled after we know the total
        // «ЦЕНА ПРОДАЖИ» в карточке товара. null — SKU продавался, но его уже
        // нет в каталоге Kaspi (или синк ещё не проходил).
        listedPrice,
        // Средняя цена, по которой позиция реально ушла за период. Делим здесь,
        // а не на фронте: у позиции без продаж units = 0, и деление там дало бы
        // Infinity, а округление разошлось бы с таблицей.
        unitPrice,
        unitProfit: units > 0 ? Math.round(profit / units) : 0,
        // Цена на витрине не совпадает с тем, по чему покупали. Для карточки
        // это повод показать оговорку: цена × продажи здесь не даст выручку.
        priceChanged:
          listedPrice != null && units > 0 && listedPrice !== unitPrice,
        status: productStatus(profit, marginPct),
        returnsLevel: (returnsPct > HIGH_RETURNS_PCT
          ? 'high'
          : 'normal') as ReturnsLevel,
      };
    });

    // Search
    if (q.search) {
      const s = q.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(s) || r.sku.toLowerCase().includes(s),
      );
    }

    const totalProfit = rows.reduce((s, r) => s + r.profit, 0);
    const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
    const totalUnits = rows.reduce((s, r) => s + r.units, 0);
    for (const r of rows) {
      r.profitSharePct =
        totalProfit > 0 ? +((r.profit / totalProfit) * 100).toFixed(1) : 0;
    }

    // Filter tabs
    if (q.filter === 'top') rows = rows.filter((r) => r.profit > 0);
    // Тот же порог, что и у бейджа в карточке товара — см. productStatus.
    else if (q.filter === 'weak')
      rows = rows.filter((r) => r.status !== 'profitable');

    // Sort: top/all by profit desc; weak worst-first (profit asc).
    rows.sort((a, b) =>
      q.filter === 'weak' ? a.profit - b.profit : b.profit - a.profit,
    );

    const total = rows.length;
    const start = (q.page - 1) * q.limit;
    const data = rows.slice(start, start + q.limit);

    return {
      period: q.period,
      from,
      to,
      filter: q.filter,
      total,
      page: q.page,
      limit: q.limit,
      totals: { revenue: totalRevenue, profit: totalProfit, units: totalUnits },
      data,
    };
  }

  // --- Карточка товара в «Настройках» («Себестоимость товаров») -------------

  /**
   * Прибыль с единицы ОТ ЦЕНЫ НА ВИТРИНЕ — вопрос «сколько я зарабатываю, если
   * продам ещё одну штуку по текущей цене».
   *
   * Это НЕ то же самое, что `unitProfit` в «Товарной статистике»: там прибыль
   * делится на фактические продажи за период. Здесь продажи не участвуют вовсе,
   * поэтому и реальной доставки (она приходит из заказов) в расчёте нет — из
   * затрат учитываются только настроенные статьи и налог.
   */
  private async listedUnitEconomics(
    sellerId: string,
    listedPrice: number,
    cost: number | null,
  ) {
    const settings = await this.ensureSeeded(sellerId);
    const categories = await this.listCategories(sellerId);
    const percentRate =
      categories
        .filter((c) => c.kind === 'percent')
        .reduce((s, c) => s + Number(c.value), 0) / 100;
    const fixedPerUnit = categories
      .filter((c) => c.kind === 'fixed')
      .reduce((s, c) => s + Number(c.value), 0);
    const taxRate = Number(settings.taxPercent) / 100;

    if (cost == null || listedPrice <= 0) {
      return { unitProfit: null, marginPct: null, expensesPerUnit: null };
    }
    const expensesPerUnit = Math.round(
      listedPrice * (percentRate + taxRate) + fixedPerUnit,
    );
    const unitProfit = listedPrice - cost - expensesPerUnit;
    return {
      unitProfit,
      marginPct: +((unitProfit / listedPrice) * 100).toFixed(1),
      expensesPerUnit,
    };
  }

  /** Всё, что показывает карточка товара, одним запросом. */
  async getProductCard(sellerId: string, userId: string, sku: string) {
    await this.assertOwned(sellerId, userId);

    const [product] = await this.db
      .select({
        sku: kaspiProducts.sku,
        title: kaspiProducts.title,
        listedPrice: kaspiProducts.priceMin,
        costPrice: kaspiProducts.costPrice,
        available: kaspiProducts.available,
        totalStock: kaspiProducts.totalStock,
        archivedAt: kaspiProducts.archivedAt,
      })
      .from(kaspiProducts)
      .where(
        and(eq(kaspiProducts.sellerId, sellerId), eq(kaspiProducts.sku, sku)),
      )
      .limit(1);
    if (!product) {
      throw new NotFoundException(`Product ${sku} not found for this seller`);
    }

    const priceRows = await this.db
      .select({
        price: productPriceHistory.price,
        observedAt: productPriceHistory.observedAt,
        source: productPriceHistory.source,
      })
      .from(productPriceHistory)
      .where(
        and(
          eq(productPriceHistory.sellerId, sellerId),
          eq(productPriceHistory.sku, sku),
        ),
      )
      .orderBy(productPriceHistory.observedAt);

    const costRows = await this.db
      .select({
        id: productCostHistory.id,
        cost: productCostHistory.cost,
        effectiveFrom: productCostHistory.effectiveFrom,
      })
      .from(productCostHistory)
      .where(
        and(
          eq(productCostHistory.sellerId, sellerId),
          eq(productCostHistory.sku, sku),
        ),
      )
      .orderBy(productCostHistory.effectiveFrom);

    const now = Date.now();
    // «Текущая» — последняя запись, которая УЖЕ вступила в силу: дату можно
    // поставить будущую, и такая запись ещё не действует.
    const currentCostIdx = costRows.reduce(
      (best, r, i) => (r.effectiveFrom.getTime() <= now ? i : best),
      -1,
    );
    const economics = await this.listedUnitEconomics(
      sellerId,
      product.listedPrice,
      product.costPrice,
    );

    return {
      ...product,
      ...economics,
      status:
        economics.unitProfit == null || economics.marginPct == null
          ? null
          : productStatus(economics.unitProfit, economics.marginPct),
      // «ИСТОРИЯ ЦЕНЫ ПРОДАЖИ». changeFromPrev — та самая «+150» в макете.
      priceHistory: priceRows.map((r, i) => ({
        ...r,
        changeFromPrev: i === 0 ? null : r.price - priceRows[i - 1].price,
        isCurrent: i === priceRows.length - 1,
      })),
      // «ИСТОРИЯ СЕБЕСТОИМОСТИ»
      costHistory: costRows.map((r, i) => ({
        ...r,
        changeFromPrev: i === 0 ? null : r.cost - costRows[i - 1].cost,
        isCurrent: i === currentCostIdx,
      })),
    };
  }

  /**
   * Записать себестоимость, действующую с даты, и подтянуть `cost_price` к
   * актуальной записи.
   *
   * `kaspi_products.cost_price` остаётся «текущим значением»: на него смотрят
   * массовые операции, списки и запасная ветка в расчёте COGS. Источник правды
   * для дат — история, поэтому после каждой правки истории значение в карточке
   * пересчитывается из неё. Вызывающий обязан сам проверить владение продавцом.
   */
  async recordCost(
    sellerId: string,
    sku: string,
    cost: number,
    effectiveFrom: Date = new Date(),
  ) {
    await this.db
      .insert(productCostHistory)
      .values({ sellerId, sku, cost, effectiveFrom })
      .onConflictDoUpdate({
        target: [
          productCostHistory.sellerId,
          productCostHistory.sku,
          productCostHistory.effectiveFrom,
        ],
        set: { cost },
      });
    await this.syncCurrentCost(sellerId, sku);
  }

  /**
   * Очистить себестоимость товара («не заполнено»).
   *
   * История при этом удаляется, и это не побочный эффект: пока в ней остаётся
   * хоть одна запись, `syncCurrentCost()` вернёт значение обратно, и очистка
   * молча отменится. «Себестоимость неизвестна» и «история пуста» — одно и то
   * же состояние.
   */
  async clearCost(sellerId: string, sku: string) {
    await this.db
      .delete(productCostHistory)
      .where(
        and(
          eq(productCostHistory.sellerId, sellerId),
          eq(productCostHistory.sku, sku),
        ),
      );
    await this.db
      .update(kaspiProducts)
      .set({ costPrice: null })
      .where(
        and(eq(kaspiProducts.sellerId, sellerId), eq(kaspiProducts.sku, sku)),
      );
  }

  /** Подтянуть `kaspi_products.cost_price` к записи, действующей сейчас. */
  private async syncCurrentCost(sellerId: string, sku: string) {
    const [current] = await this.db
      .select({ cost: productCostHistory.cost })
      .from(productCostHistory)
      .where(
        and(
          eq(productCostHistory.sellerId, sellerId),
          eq(productCostHistory.sku, sku),
          lte(productCostHistory.effectiveFrom, new Date()),
        ),
      )
      .orderBy(desc(productCostHistory.effectiveFrom))
      .limit(1);
    await this.db
      .update(kaspiProducts)
      .set({ costPrice: current?.cost ?? null })
      .where(
        and(eq(kaspiProducts.sellerId, sellerId), eq(kaspiProducts.sku, sku)),
      );
    return current?.cost ?? null;
  }

  /** «Добавить» новую себестоимость из карточки товара. */
  async addCostEntry(
    sellerId: string,
    userId: string,
    sku: string,
    cost: number,
    effectiveFrom?: string,
  ) {
    await this.assertOwned(sellerId, userId);
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
    await this.recordCost(
      sellerId,
      sku,
      cost,
      effectiveFrom ? new Date(effectiveFrom) : new Date(),
    );
    return this.getProductCard(sellerId, userId, sku);
  }

  /** «Карандаш» — правка записи истории себестоимости. */
  async updateCostEntry(
    sellerId: string,
    userId: string,
    sku: string,
    entryId: string,
    patch: { cost?: number; effectiveFrom?: string },
  ) {
    await this.assertOwned(sellerId, userId);
    const set: { cost?: number; effectiveFrom?: Date } = {};
    if (patch.cost != null) set.cost = patch.cost;
    if (patch.effectiveFrom) set.effectiveFrom = new Date(patch.effectiveFrom);
    if (Object.keys(set).length === 0) {
      throw new BadRequestException(
        'Nothing to update: pass cost and/or effectiveFrom',
      );
    }
    const [row] = await this.db
      .update(productCostHistory)
      .set(set)
      .where(
        and(
          eq(productCostHistory.id, entryId),
          eq(productCostHistory.sellerId, sellerId),
          eq(productCostHistory.sku, sku),
        ),
      )
      .returning({ id: productCostHistory.id });
    if (!row) throw new NotFoundException(`Cost entry ${entryId} not found`);
    await this.syncCurrentCost(sellerId, sku);
    return this.getProductCard(sellerId, userId, sku);
  }

  /** «Корзина» — удаление записи истории себестоимости. */
  async deleteCostEntry(
    sellerId: string,
    userId: string,
    sku: string,
    entryId: string,
  ) {
    await this.assertOwned(sellerId, userId);
    const [row] = await this.db
      .delete(productCostHistory)
      .where(
        and(
          eq(productCostHistory.id, entryId),
          eq(productCostHistory.sellerId, sellerId),
          eq(productCostHistory.sku, sku),
        ),
      )
      .returning({ id: productCostHistory.id });
    if (!row) throw new NotFoundException(`Cost entry ${entryId} not found`);
    // Удалили последнюю запись — себестоимость товара снова «не заполнена»,
    // и он вернётся в «14 из 38 не заполнено».
    await this.syncCurrentCost(sellerId, sku);
    return this.getProductCard(sellerId, userId, sku);
  }
}
