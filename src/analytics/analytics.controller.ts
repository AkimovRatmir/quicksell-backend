import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { UserThrottlerGuard } from '../auth/user-throttler.guard';
import { AiInsightsService } from './ai-insights.service';
import { AnalyticsService } from './analytics.service';
import { UnitEconomicsService } from './unit-economics.service';
import { BulkCostDto, BulkCostPercentDto } from './dto/bulk-cost.dto';
import {
  CreateExpenseCategoryDto,
  UpdateExpenseCategoryDto,
} from './dto/expense-category.dto';
import { AddCostEntryDto, UpdateCostEntryDto } from './dto/product-cost.dto';
import { ProductStatsQueryDto } from './dto/product-stats-query.dto';
import { UnitEconomicsDto } from './dto/unit-economics.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analytics/sellers/:id')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly unitEconomics: UnitEconomicsService,
    private readonly aiInsights: AiInsightsService,
  ) {}

  // --- Settings screen: goals + expense categories -------------------------

  @Get('settings')
  @ApiOperation({
    summary: 'Analytics settings (goals + expense categories)',
    description:
      'Returns «Цели бизнеса», the auto-apply toggle, and the expense-category list. Seeds sensible defaults (Комиссия Kaspi 15%, Упаковка 150 ₸, Доставка 600 ₸, Возвраты 3%) the first time it is opened.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        applyExpensesAuto: true,
        goals: { targetProfitPct: 20, minProfitPct: 10, paybackMonths: 3 },
        expenseCategories: [
          {
            id: 'uuid',
            name: 'Комиссия Kaspi',
            kind: 'percent',
            value: 15,
            color: '#6C5CE7',
            sortOrder: 0,
          },
        ],
      },
    },
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  getSettings(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.analytics.getSettings(id, user.userId);
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Update «Цели бизнеса» / auto-apply toggle' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  updateSettings(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSettingsDto,
  ) {
    return this.analytics.updateSettings(id, user.userId, dto);
  }

  @Get('expense-categories')
  @ApiOperation({ summary: 'List expense categories' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  listCategories(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.analytics.listExpenseCategories(id, user.userId);
  }

  @Post('expense-categories')
  @ApiOperation({ summary: 'Add an expense category' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  addCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateExpenseCategoryDto,
  ) {
    return this.analytics.addExpenseCategory(id, user.userId, dto);
  }

  @Patch('expense-categories/:categoryId')
  @ApiOperation({ summary: 'Update an expense category' })
  @ApiNotFoundResponse({ description: 'Category not found for this seller.' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateExpenseCategoryDto,
  ) {
    return this.analytics.updateExpenseCategory(
      id,
      user.userId,
      categoryId,
      dto,
    );
  }

  @Delete('expense-categories/:categoryId')
  @ApiOperation({ summary: 'Remove an expense category' })
  @ApiNotFoundResponse({ description: 'Category not found for this seller.' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  deleteCategory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
  ) {
    return this.analytics.deleteExpenseCategory(id, user.userId, categoryId);
  }

  // --- Cost prices («Себестоимость») bulk apply ----------------------------

  @Post('products/cost/bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk-apply one cost price to products («Быстрый старт»)',
    description:
      'Sets costPrice on many products at once. By default only products that have no cost yet are touched (onlyUnfilled=true); pass false to overwrite all.',
  })
  @ApiOkResponse({ schema: { example: { updated: 14 } } })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  bulkCost(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BulkCostDto,
  ) {
    return this.analytics.bulkApplyCost(id, user.userId, dto);
  }

  @Post('products/cost/bulk-percent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set each product's cost to a % of its own sale price",
    description:
      'For every product, cost = percent% × its sale price (priceMin), rounded to whole tenge. E.g. percent=60 → a 5000 ₸ product gets cost 3000; a 900 ₸ product gets 540. By default overwrites all (onlyUnfilled=false); pass true to only fill empty ones.',
  })
  @ApiOkResponse({ schema: { example: { updated: 627, percent: 60 } } })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  bulkCostPercent(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BulkCostPercentDto,
  ) {
    return this.analytics.bulkApplyCostPercent(id, user.userId, dto);
  }

  // --- Profit & expenses dashboard («Прибыль и расходы») --------------------

  @Get('profit')
  @ApiOperation({
    summary: 'Profit & expenses summary for a period',
    description:
      'Revenue, COGS, operating expenses, net profit, margin, expenses-by-category, revenue composition, and vs-previous-period deltas. Revenue = COMPLETED orders by creation date. COGS = line items × product cost. Delivery is the real Kaspi cost; commission/packaging come from expense categories; tax from settings. period = 7d | 30d | 90d | 12m.',
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  profit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('period', new DefaultValuePipe('30d')) period: string,
  ) {
    return this.analytics.getProfitSummary(id, user.userId, period);
  }

  @Get('monthly')
  @ApiOperation({
    summary: 'Revenue & profit by month («Выручка и прибыль по месяцам»)',
    description:
      'Zero-filled monthly series for the last `months` months (default 12).',
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  monthly(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('months', new DefaultValuePipe(12), ParseIntPipe) months: number,
  ) {
    return this.analytics.getMonthly(
      id,
      user.userId,
      Math.min(Math.max(months, 1), 24),
    );
  }

  @Get('product-stats')
  @ApiOperation({
    summary: 'Per-product statistics («Товарная статистика»)',
    description:
      'Per-product sales, revenue, net profit, profit share, margin, returns %, and trend vs the previous period. Pure read over stored orders. period=7d|30d|90d|12m; filter=all|top|weak; supports search + pagination. Every row also carries what the product card («карточка товара») shows: listedPrice («ЦЕНА ПРОДАЖИ» — the current Kaspi price from kaspi_products.price_min, null if the SKU is no longer in the catalogue), unitPrice (what it ACTUALLY sold for on average this period = revenue/units), priceChanged (true when those two differ — the price moved, or a promo ran, so listedPrice × units will NOT equal revenue), unitProfit (0 when the SKU had no sales), status (profitable | low_margin | loss — the «Прибыльный» badge, and the same predicate filter=weak uses) and returnsLevel (normal | high — the «в норме» caption).',
  })
  @ApiOkResponse({
    schema: {
      example: {
        period: '30d',
        total: 182,
        page: 1,
        limit: 20,
        totals: { revenue: 2256444, profit: 129693, units: 1121 },
        data: [
          {
            sku: '275751891',
            title: 'КосмоВент гибкий воздуховод…',
            units: 18,
            revenue: 267000,
            profit: 105540,
            marginPct: 39.5,
            profitSharePct: 11,
            returnsPct: 0,
            trendPct: -3,
            costMissing: false,
            listedPrice: 14950,
            unitPrice: 14833,
            priceChanged: true,
            unitProfit: 5863,
            status: 'profitable',
            returnsLevel: 'normal',
          },
        ],
      },
    },
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  productStats(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ProductStatsQueryDto,
  ) {
    return this.analytics.getProductStats(id, user.userId, q);
  }

  @Post('ai-insights')
  // Cached answers are cheap, but each miss is a paid OpenAI call. The
  // service also rate-limits forced refreshes; this caps a runaway client.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'AI business insights («AI-инсайт») — one call, all sections',
    description:
      'PRO-ONLY (403 code PRO_REQUIRED for free users — enforced server-side). Feeds our stored analytics for ONE period to OpenAI and returns ONE structured JSON with every dashboard section: headline (verdict + text + tags), requiresAction (max 3), growthPoints (3), profitInsight, expensesInsight, productsInsight. The model leads with whichever is bigger in ₸/мес — the largest money leak or the largest growth opportunity. Period must be one of 7d / 30d / 90d / 12m (400 otherwise); the result is cached per (seller, period) and reused for 24h, so each period keeps its own analysis. Pass ?force=true to regenerate. Requires OPENAI_API_KEY (503 if unset).',
  })
  @ApiQuery({
    name: 'period',
    required: false,
    enum: ['7d', '30d', '90d', '12m'],
    description:
      'Окно анализа. Инсайт хранится и отдаётся отдельно по каждому.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        generatedAt: '2026-08-17T10:00:00.000Z',
        model: 'gpt-4o-mini',
        period: '30d',
        insights: {
          period: 'за 30 дней',
          headline: {
            verdict: { label: 'под давлением', tone: 'negative' },
            text: 'Магазин под давлением: выручка растёт (+13.4%), но прибыль просела на 3.5% — Стекло iPhone 14 уходит в минус на 2 100 ₸/мес из-за высоких возвратов (8.9%), стоит пересмотреть цену или снять товар с продажи. Точка роста — USB-C: +12% при марже 29%, увеличьте закупку, потенциал +120 000 ₸/мес.',
            tags: [{ label: 'Возвраты съедают маржу', tone: 'warning' }],
          },
          requiresAction: [
            {
              title: 'Стекло iPhone 14',
              detail:
                'Убыток 2 100 ₸/мес из-за возвратов 8.9% — пересмотрите цену или снимите с продажи',
              badge: 'убыток −2 100 ₸/мес',
              tone: 'negative',
            },
          ],
          growthPoints: [
            {
              title: 'Увеличить закупку USB-C',
              detail: 'Рост +12% при марже 29%',
              potential: '+120 000 ₸/мес',
              tone: 'positive',
            },
          ],
          profitInsight: { text: '...' },
          expensesInsight: { text: '...' },
          productsInsight: { text: '...' },
        },
      },
    },
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  aiInsightsGenerate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('period', new DefaultValuePipe('30d')) period: string,
    @Query('force') force?: string,
  ) {
    return this.aiInsights.generate(id, user.userId, period, force === 'true');
  }

  // --- Unit economics («Юнит-экономика») -----------------------------------

  @Post('unit-economics')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run a unit-economics calculation («Рассчитать»)',
    description:
      'Computes per-unit profit, margin, ROI (окупаемость), monthly profit, a recommended price to hit the target margin, and the full cost structure. Saves it to history. Free plan is limited to 10 calculations/month (Pro is unlimited); the response includes usage/remaining.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'uuid',
        result: {
          totalCostPerUnit: 4004,
          profitPerUnit: 996,
          marginPct: 19.92,
          roiPct: 24.88,
          monthlyProfit: 99600,
          recommendedPrice: 4808,
        },
        costStructure: [
          { key: 'cogs', label: 'Себестоимость', amount: 2000, share: 50 },
        ],
        usage: { plan: 'free', limit: 10, used: 1, remaining: 9 },
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      'Free monthly limit reached (code FREE_LIMIT_REACHED) or seller belongs to another user.',
  })
  calcUnitEconomics(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnitEconomicsDto,
  ) {
    return this.unitEconomics.calculate(id, user.userId, dto);
  }

  @Get('unit-economics')
  @ApiOperation({
    summary: 'Calculation history («Посмотреть историю расчётов») + usage',
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  unitEconomicsHistory(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.unitEconomics.history(
      id,
      user.userId,
      Math.min(Math.max(limit, 1), 100),
    );
  }

  // --- Карточка товара («Себестоимость товаров» в «Настройках») -------------
  // NB: объявлено ПОСЛЕ `products/cost/bulk` — иначе `products/:sku/cost`
  // перехватил бы массовые операции, приняв «cost» за SKU.

  @Get('products/:sku/card')
  @ApiOperation({
    summary: 'Product card («карточка товара») — one call for the whole popup',
    description:
      'Current listed price, current cost, per-unit profit/margin at that listed price, plus «ИСТОРИЯ ЦЕНЫ ПРОДАЖИ» and «ИСТОРИЯ СЕБЕСТОИМОСТИ». unitProfit here is computed FROM THE LISTED PRICE (what one more sale earns) minus the configured expense categories and tax — it is NOT the sales-based unitProfit from product-stats, and it excludes real per-order delivery. null when the cost is not filled in yet. priceHistory rows carry source: «order» = the price it actually sold at (back-filled from orders, the only history Kaspi lets us know), «kaspi_sync» = the shop-front price observed by a sync.',
  })
  @ApiNotFoundResponse({
    description: 'No product with that SKU for this seller.',
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  productCard(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sku') sku: string,
  ) {
    return this.analytics.getProductCard(id, user.userId, sku);
  }

  @Post('products/:sku/cost')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add a cost price («Добавить» в истории себестоимости)',
    description:
      'Appends an entry effective from `effectiveFrom` (default: now) and re-points the product’s current cost at whichever entry is in force. COGS for orders placed on/after that date uses the new cost; earlier orders keep the previous one. Returns the refreshed card.',
  })
  @ApiNotFoundResponse({
    description: 'No product with that SKU for this seller.',
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  addCostEntry(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sku') sku: string,
    @Body() dto: AddCostEntryDto,
  ) {
    return this.analytics.addCostEntry(
      id,
      user.userId,
      sku,
      dto.cost,
      dto.effectiveFrom,
    );
  }

  @Patch('products/:sku/cost/:entryId')
  @ApiOperation({
    summary: 'Edit a cost-history entry («карандаш»)',
    description: 'Pass cost and/or effectiveFrom. Returns the refreshed card.',
  })
  @ApiNotFoundResponse({ description: 'No such cost entry for this product.' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  updateCostEntry(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sku') sku: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: UpdateCostEntryDto,
  ) {
    return this.analytics.updateCostEntry(id, user.userId, sku, entryId, dto);
  }

  @Delete('products/:sku/cost/:entryId')
  @ApiOperation({
    summary: 'Delete a cost-history entry («корзина»)',
    description:
      'Removing the last remaining entry leaves the product with no cost at all, so it returns to «не заполнено». Returns the refreshed card.',
  })
  @ApiNotFoundResponse({ description: 'No such cost entry for this product.' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  deleteCostEntry(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sku') sku: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.analytics.deleteCostEntry(id, user.userId, sku, entryId);
  }
}
