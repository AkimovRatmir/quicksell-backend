import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, gte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import {
  type UnitEconomicsRow,
  sellers,
  unitEconomicsCalculations,
  users,
} from '../database/schema';
import { UnitEconomicsDto } from './dto/unit-economics.dto';

/** Free plan: this many unit-economics calcs per calendar month. */
const FREE_MONTHLY_LIMIT = 10;

const COST_META: Record<string, { label: string; color: string }> = {
  cogs: { label: 'Себестоимость', color: '#6C5CE7' },
  deliveryToWarehouse: { label: 'Доставка до склада', color: '#A29BFE' },
  commission: { label: 'Комиссия Kaspi', color: '#E17055' },
  deliveryToCustomer: { label: 'Доставка покупателю', color: '#FDCB6E' },
  packaging: { label: 'Упаковка', color: '#22C55E' },
  advertising: { label: 'Реклама', color: '#3B82F6' },
  returns: { label: 'Возвраты', color: '#EF4444' },
  other: { label: 'Прочее', color: '#6B7280' },
};

@Injectable()
export class UnitEconomicsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  private async assertOwned(sellerId: string, userId: string): Promise<void> {
    const [seller] = await this.db
      .select({ id: sellers.id, userId: sellers.userId })
      .from(sellers)
      .where(eq(sellers.id, sellerId))
      .limit(1);
    if (!seller) throw new NotFoundException(`Seller ${sellerId} not found`);
    if (seller.userId !== userId) throw new ForbiddenException('Not your seller');
  }

  /** Pure math — no I/O. Returns the snapshot fields + cost breakdown. */
  private compute(dto: UnitEconomicsDto) {
    const salePrice = dto.salePrice;
    const commissionPct = dto.kaspiCommissionPct ?? 0;
    const returnsPct = dto.returnsPct ?? 0;

    const cost = {
      cogs: dto.costPrice ?? 0,
      deliveryToWarehouse: dto.deliveryToWarehouse ?? 0,
      commission: Math.round((commissionPct / 100) * salePrice),
      deliveryToCustomer: dto.deliveryToCustomer ?? 0,
      packaging: dto.packaging ?? 0,
      advertising: dto.advertisingPerUnit ?? 0,
      returns: Math.round((returnsPct / 100) * salePrice),
      other: dto.otherExpenses ?? 0,
    };
    const totalCost = Object.values(cost).reduce((s, v) => s + v, 0);
    const profitPerUnit = salePrice - totalCost;
    const marginPct = salePrice > 0 ? (profitPerUnit / salePrice) * 100 : 0;
    const roiPct = totalCost > 0 ? (profitPerUnit / totalCost) * 100 : null;
    const monthlyProfit = profitPerUnit * (dto.salesPerMonth ?? 0);

    // Price to hit the target margin (margin as % of price):
    //   price·(1 − commission% − returns% − target%) = fixed costs
    const fixedCost =
      cost.cogs +
      cost.deliveryToWarehouse +
      cost.deliveryToCustomer +
      cost.packaging +
      cost.advertising +
      cost.other;
    const denom = 1 - (commissionPct + returnsPct + (dto.targetMarginPct ?? 0)) / 100;
    const recommendedPrice = denom > 0 ? Math.round(fixedCost / denom) : null;

    const costStructure = Object.entries(cost).map(([key, amount]) => ({
      key,
      label: COST_META[key].label,
      color: COST_META[key].color,
      amount,
      share: totalCost > 0 ? +((amount / totalCost) * 100).toFixed(1) : 0,
    }));

    return {
      totalCostPerUnit: totalCost,
      profitPerUnit,
      marginPct: +marginPct.toFixed(2),
      roiPct: roiPct === null ? null : +roiPct.toFixed(2),
      monthlyProfit,
      recommendedPrice,
      costStructure,
    };
  }

  private async monthlyUsage(userId: string) {
    const now = new Date();
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const [{ used }] = await this.db
      .select({ used: count() })
      .from(unitEconomicsCalculations)
      .where(
        and(
          eq(unitEconomicsCalculations.userId, userId),
          gte(unitEconomicsCalculations.createdAt, monthStart),
        ),
      );
    const [user] = await this.db
      .select({ plan: users.plan })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return { used: Number(used), plan: user?.plan ?? 'free' };
  }

  private view(row: UnitEconomicsRow, costStructure: unknown) {
    return {
      id: row.id,
      createdAt: row.createdAt,
      inputs: {
        salePrice: row.salePrice,
        costPrice: row.costPrice,
        kaspiCommissionPct: Number(row.kaspiCommissionPct),
        deliveryToCustomer: row.deliveryToCustomer,
        deliveryToWarehouse: row.deliveryToWarehouse,
        packaging: row.packaging,
        advertisingPerUnit: row.advertisingPerUnit,
        returnsPct: Number(row.returnsPct),
        otherExpenses: row.otherExpenses,
        salesPerMonth: row.salesPerMonth,
        targetMarginPct: Number(row.targetMarginPct),
      },
      result: {
        totalCostPerUnit: row.totalCostPerUnit,
        profitPerUnit: row.profitPerUnit,
        marginPct: Number(row.marginPct),
        roiPct: row.roiPct === null ? null : Number(row.roiPct),
        monthlyProfit: row.monthlyProfit,
        recommendedPrice: row.recommendedPrice,
      },
      costStructure,
    };
  }

  /** Run a calculation, enforce the free quota, persist, and return it. */
  async calculate(sellerId: string, userId: string, dto: UnitEconomicsDto) {
    await this.assertOwned(sellerId, userId);
    const { used, plan } = await this.monthlyUsage(userId);
    if (plan !== 'pro' && used >= FREE_MONTHLY_LIMIT) {
      throw new ForbiddenException({
        code: 'FREE_LIMIT_REACHED',
        message: `Достигнут лимит бесплатных расчётов (${FREE_MONTHLY_LIMIT}/мес). Оформите Pro, чтобы убрать лимит.`,
        limit: FREE_MONTHLY_LIMIT,
        used,
      });
    }

    const c = this.compute(dto);
    const [row] = await this.db
      .insert(unitEconomicsCalculations)
      .values({
        sellerId,
        userId,
        salePrice: dto.salePrice,
        costPrice: dto.costPrice ?? 0,
        kaspiCommissionPct: String(dto.kaspiCommissionPct ?? 0),
        deliveryToCustomer: dto.deliveryToCustomer ?? 0,
        deliveryToWarehouse: dto.deliveryToWarehouse ?? 0,
        packaging: dto.packaging ?? 0,
        advertisingPerUnit: dto.advertisingPerUnit ?? 0,
        returnsPct: String(dto.returnsPct ?? 0),
        otherExpenses: dto.otherExpenses ?? 0,
        salesPerMonth: dto.salesPerMonth ?? 0,
        targetMarginPct: String(dto.targetMarginPct ?? 0),
        totalCostPerUnit: c.totalCostPerUnit,
        profitPerUnit: c.profitPerUnit,
        marginPct: String(c.marginPct),
        roiPct: c.roiPct === null ? null : String(c.roiPct),
        monthlyProfit: c.monthlyProfit,
        recommendedPrice: c.recommendedPrice,
      })
      .returning();

    const usedAfter = used + 1;
    return {
      ...this.view(row, c.costStructure),
      usage: {
        plan,
        limit: plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
        used: usedAfter,
        remaining: plan === 'pro' ? null : Math.max(0, FREE_MONTHLY_LIMIT - usedAfter),
      },
    };
  }

  /** Recent calculations («Посмотреть историю расчётов»). */
  async history(sellerId: string, userId: string, limit: number) {
    await this.assertOwned(sellerId, userId);
    const rows = await this.db
      .select()
      .from(unitEconomicsCalculations)
      .where(eq(unitEconomicsCalculations.sellerId, sellerId))
      .orderBy(desc(unitEconomicsCalculations.createdAt))
      .limit(limit);
    const { used, plan } = await this.monthlyUsage(userId);
    return {
      usage: {
        plan,
        limit: plan === 'pro' ? null : FREE_MONTHLY_LIMIT,
        used,
        remaining: plan === 'pro' ? null : Math.max(0, FREE_MONTHLY_LIMIT - used),
      },
      data: rows.map((r) => this.view(r, this.compute(this.view(r, null).inputs).costStructure)),
    };
  }
}
