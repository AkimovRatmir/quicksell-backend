import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';
import { aiInsightsCache, sellers, users } from '../database/schema';
import { AnalyticsService } from './analytics.service';

/** Regenerate at most once a day; a Pro "refresh" bypasses this. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** A forced refresh regenerates at most this often per (seller, period). */
const FORCE_REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * The insight is always about ONE period window, and every row is cached per
 * (seller, period) — so «7 дней» and «12 месяцев» never show each other's
 * numbers and switching the period switches the whole analysis.
 */
export const AI_PERIODS = ['7d', '30d', '90d', '12m'] as const;
export type AiPeriod = (typeof AI_PERIODS)[number];

const PERIOD_DAYS: Record<AiPeriod, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '12m': 365,
};
const PERIOD_LABEL: Record<AiPeriod, string> = {
  '7d': 'за 7 дней',
  '30d': 'за 30 дней',
  '90d': 'за 90 дней',
  '12m': 'за 12 месяцев',
};

/** «Требуют действий» — до трёх карточек, «Точки роста» — всегда три. */
const MAX_ACTIONS = 3;
const GROWTH_POINTS = 3;

/**
 * JSON Schema for the AI response. OpenAI Structured Outputs guarantees the
 * model returns exactly this shape (strict mode), so the frontend can navigate
 * `headline / requiresAction / growthPoints / profitInsight / expensesInsight /
 * productsInsight` without defensive parsing.
 *
 * Note: strict mode rejects `minItems`/`maxItems`, so the «max 3 / exactly 3»
 * rules live in the prompt and are enforced again in `normalize()` below.
 */
export const INSIGHTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'period',
    'headline',
    'requiresAction',
    'growthPoints',
    'profitInsight',
    'expensesInsight',
    'productsInsight',
  ],
  properties: {
    period: { type: 'string' },
    // «Главная» — оценка состояния + самая крупная утечка и самая крупная
    // точка роста одним абзацем.
    headline: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'text', 'tags'],
      properties: {
        // Оценка состояния бизнеса: «стабилен» / «под давлением». Отдаётся
        // отдельным полем, а не угадывается на фронте по словарю — цвет
        // (зелёный/красный) должен совпадать со смыслом, который вложила модель.
        verdict: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'tone'],
          properties: {
            label: { type: 'string' },
            tone: { type: 'string', enum: ['positive', 'negative'] },
          },
        },
        text: { type: 'string' },
        tags: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'tone'],
            properties: {
              label: { type: 'string' },
              tone: {
                type: 'string',
                enum: ['positive', 'negative', 'warning', 'neutral'],
              },
            },
          },
        },
      },
    },
    // «Требуют действий»
    requiresAction: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'badge', 'tone'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          badge: { type: 'string' },
          tone: { type: 'string', enum: ['negative', 'warning', 'neutral'] },
        },
      },
    },
    // «Точки роста»
    growthPoints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'potential', 'tone'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          potential: { type: 'string' },
          tone: { type: 'string', enum: ['positive', 'neutral'] },
        },
      },
    },
    // «Прибыль и расходы» — две отдельные строки, каждая со своей оценкой.
    profitInsight: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    expensesInsight: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    // «Товарная статистика» — 1-2 предложения свободным текстом.
    productsInsight: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
  },
} as const;

export const SYSTEM_PROMPT = `Ты — финансовый аналитик для продавца на маркетплейсе Kaspi.kz (Казахстан).
Тебе дают JSON с реальными метриками магазина ЗА ОДИН ПЕРИОД: выручка, прибыль, маржа, расходы по статьям, убыточные товары, кандидаты на рост, помесячная динамика.

ТВОЯ ЗАДАЧА: найти, где утекает больше всего денег и где их можно больше всего заработать, показать самое крупное из двух и оценить состояние бизнеса.

ЖЁСТКИЕ ПРАВИЛА
- Пиши ПО-РУССКИ и опирайся СТРОГО на присланные числа. НИКОГДА не выдумывай товары, суммы и проценты, которых нет во входе.
- Все суммы — в тенге (₸), ровно как во входных данных. Суммы вида «₸/мес» бери из готовых полей perMonth, не пересчитывай сам.
- Долю статьи расходов бери ТОЛЬКО из её готовой строки summary и не пересобирай сам: pctOfRevenue — доля в выручке, pctOfTotalExpenses — доля во всех расходах, это РАЗНЫЕ числа.
- Формат — сплошной связный текст. НИКАКИХ списков, маркеров, нумерации, заголовков, markdown и переносов строк.
- Не начинай тексты со слов «Оценка:», «Прибыль:», «Расходы:» — эти заголовки уже нарисованы в интерфейсе.

headline — блок на «Главной», 1-2 предложения одним абзацем:
- headline.verdict.label — оценка состояния бизнеса в 1-3 слова («стабилен», «под давлением», «теряет прибыль»). tone: positive, если оценка хорошая, negative — если плохая.
- headline.text ОБЯЗАН содержать эту оценку слово в слово, обычно в начале: «Магазин под давлением: …», «Бизнес стабилен, …».
- Дальше в headline.text: сначала САМОЕ КРУПНОЕ из двух — точка убыточности или точка роста (поле leadWith подсказывает, что крупнее по ₸/мес), с конкретным товаром или статьёй расходов, цифрой и советом что сделать; затем вторая сторона, тоже с советом.
- headline.tags — 2-4 очень коротких ярлыка, не предложения.

requiresAction — «Требуют действий», НЕ БОЛЬШЕ ${MAX_ACTIONS}. Стремись дать ровно ${MAX_ACTIONS}. Сначала бери убыточные товары из lossMakingProducts, затем ДОБЕРИ до ${MAX_ACTIONS} из highReturnProducts и bloatingExpenseLines — раздувшаяся статья расходов и товар с высокими возвратами тоже требуют действий. Меньше ${MAX_ACTIONS} карточек возвращай, только если во всех трёх списках вместе проблем меньше. Сортируй по деньгам: сначала самое дорогое. title — товар или статья расходов, detail — причина с цифрами и конкретный совет, badge — короткая метка вроде «убыток −2 100 ₸/мес» или «возвраты 8.9%».

growthPoints — «Точки роста», ВСЕГДА ровно ${GROWTH_POINTS} штуки. Бери из growthCandidates (они уже отсортированы по выгоде). title — что сделать («Увеличить закупку USB-C»), detail — почему, с маржой и ростом из данных, potential — выгода из поля upsidePerMonth в формате «+120 000 ₸/мес». Если upsidePerMonth равен 0 или его нет — верни potential пустой строкой, НЕ придумывай сумму.

profitInsight.text — 1-2 предложения: оценка динамики прибыли и маржи, какие именно товары тянут прибыль вверх, и совет как этим воспользоваться.
expensesInsight.text — 1-2 предложения: оценка общих затрат, какая статья раздувается сильнее оборота и бьёт по прибыли, и совет как её сократить. Статью с fixedShareByFormula=true считают от выручки по формуле — её доля не может «раздуться», не называй такую статью растущей.
productsInsight.text — 1-2 предложения свободной формы: какие товары в плюсе, какие в минусе, и один конкретный совет.

Если данных для секции не хватает — скажи это коротко и честно, но не выдумывай цифры.`;

/** Narrow the free-form strings the model returns to the fields we render. */
export interface AiTextItem {
  title: string;
  detail: string;
  badge?: string;
  potential?: string;
  tone: string;
}
export interface AiInsightsPayload {
  period: string;
  headline: {
    verdict: { label: string; tone: string };
    text: string;
    tags: Array<{ label: string; tone: string }>;
  };
  requiresAction: AiTextItem[];
  growthPoints: AiTextItem[];
  profitInsight: { text: string };
  expensesInsight: { text: string };
  productsInsight: { text: string };
}

/**
 * Требование «сплошной текст»: модель иногда всё равно возвращает маркеры,
 * нумерацию, markdown-жирный или переносы строк. Чистим — дешевле, чем
 * перегенерировать платный ответ.
 */
function flatten(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(?:[-–—•*·]|\d+[.)])\s+/gm, '')
    .replace(/^\s*(?:оценка|прибыль|расходы)\s*:\s*/i, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Старые записи в кеше лежат в прошлой форме ответа (без verdict, с aiInsight
 * вместо productsInsight). Отдать их фронту — показать пустые блоки, поэтому
 * такую запись считаем протухшей и генерируем заново.
 */
function isCurrentShape(value: unknown): value is AiInsightsPayload {
  const i = value as Partial<AiInsightsPayload> | null;
  return (
    !!i &&
    typeof i === 'object' &&
    typeof i.headline?.text === 'string' &&
    typeof i.headline?.verdict?.label === 'string' &&
    typeof i.productsInsight?.text === 'string' &&
    Array.isArray(i.requiresAction) &&
    Array.isArray(i.growthPoints)
  );
}

@Injectable()
export class AiInsightsService {
  private readonly logger = new Logger(AiInsightsService.name);

  /** Generations in flight, by `${sellerId}:${period}` — see generate(). */
  private readonly inflight = new Map<
    string,
    ReturnType<AiInsightsService['regenerate']>
  >();

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly config: ConfigService,
    private readonly analytics: AnalyticsService,
  ) {}

  private async assertOwned(sellerId: string, userId: string): Promise<void> {
    const [seller] = await this.db
      .select({ id: sellers.id, userId: sellers.userId })
      .from(sellers)
      .where(eq(sellers.id, sellerId))
      .limit(1);
    if (!seller) throw new NotFoundException(`Seller ${sellerId} not found`);
    if (seller.userId !== userId)
      throw new ForbiddenException('Not your seller');
  }

  private async planOf(userId: string): Promise<string> {
    const [u] = await this.db
      .select({ plan: users.plan })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return u?.plan ?? 'free';
  }

  /** Assemble a compact, factual snapshot from our stored analytics. */
  private async gatherContext(
    sellerId: string,
    userId: string,
    period: AiPeriod,
  ) {
    const days = PERIOD_DAYS[period];
    /** Всё сводим к ₸/мес — иначе «7 дней» и «12 месяцев» несравнимы. */
    const perMonth = (v: number) => Math.round((v * 30) / days);

    const profit = await this.analytics.getProfitSummary(
      sellerId,
      userId,
      period,
    );
    const stats = await this.analytics.getProductStats(sellerId, userId, {
      period,
      filter: 'all',
      page: 1,
      limit: 200,
    });
    // Отдельный запрос за слабыми товарами: в «all» они лежат в хвосте
    // сортировки по прибыли и у крупного продавца просто не попадают на
    // первую страницу — а это именно то, что ищут «Требуют действий».
    const weak = await this.analytics.getProductStats(sellerId, userId, {
      period,
      filter: 'weak',
      page: 1,
      limit: 30,
    });
    const monthly = await this.analytics.getMonthly(sellerId, userId, 6);

    const products = stats.data;
    const losers = weak.data.filter((p) => p.profit < 0);
    const totalLossPerMonth = perMonth(
      losers.reduce((s, p) => s + p.profit, 0),
    );
    const top3Share = products
      .slice(0, 3)
      .reduce((s, p) => s + p.profitSharePct, 0);

    const slim = (p: (typeof products)[number]) => ({
      title: p.title,
      units: p.units,
      revenue: p.revenue,
      profit: p.profit,
      profitPerMonth: perMonth(p.profit),
      marginPct: p.marginPct,
      profitSharePct: p.profitSharePct,
      returnsPct: p.returnsPct,
      trendPct: p.trendPct,
    });

    // Кандидаты на рост: прибыльные товары, вперёд — растущие и маржинальные.
    // upsidePerMonth — сколько добавит месяц, если текущий темп роста
    // сохранится. Это оценка из наших же чисел, а не выдумка модели.
    const growthCandidates = products
      .filter((p) => p.profit > 0)
      .map((p) => ({
        ...slim(p),
        upsidePerMonth:
          p.trendPct && p.trendPct > 0
            ? perMonth(Math.round((p.profit * p.trendPct) / 100))
            : 0,
      }))
      .sort(
        (a, b) =>
          b.upsidePerMonth - a.upsidePerMonth ||
          b.profitPerMonth - a.profitPerMonth,
      )
      .slice(0, 8);

    // Статья расходов «раздувается», только если растёт быстрее выручки.
    // Проценты от выручки и налог привязаны к обороту формулой — их доля
    // постоянна по построению, и растущими их называть нельзя.
    const revenueGrowthPct = profit.comparison.revenuePct;
    const bloatingExpenseLines = profit.expensesByCategory
      .map((c) => {
        const formulaDriven = c.kind === 'percent' || c.kind === 'tax';
        let excessVsRevenueGrowth = 0;
        if (!formulaDriven && c.changePct != null && revenueGrowthPct != null) {
          const prevAmount = c.amount / (1 + c.changePct / 100);
          excessVsRevenueGrowth = Math.round(
            c.amount - prevAmount * (1 + revenueGrowthPct / 100),
          );
        }
        return {
          label: c.label,
          amount: c.amount,
          pctOfRevenue: c.shareOfRevenuePct,
          pctOfTotalExpenses: c.share,
          changePct: c.changePct,
          fixedShareByFormula: formulaDriven,
          excessVsRevenueGrowthPerMonth: perMonth(excessVsRevenueGrowth),
          // Готовая формулировка: две похожие доли модель стабильно путала
          // между собой («18.4% расходов» превращались в «18.4% выручки»).
          // Скопировать строку она не ошибается, а выбрать из двух полей — да.
          summary:
            `${c.label}: ${c.amount} ₸ — это ${c.shareOfRevenuePct}% выручки ` +
            `и ${c.share}% всех расходов`,
        };
      })
      .sort(
        (a, b) =>
          b.excessVsRevenueGrowthPerMonth - a.excessVsRevenueGrowthPerMonth ||
          b.amount - a.amount,
      );

    // «Показывай самое крупное из двух»: сравниваем главную утечку и главную
    // возможность в одних единицах — ₸/мес.
    const worstLine = bloatingExpenseLines[0];
    const leakPerMonth = Math.max(
      Math.abs(totalLossPerMonth),
      worstLine ? Math.max(worstLine.excessVsRevenueGrowthPerMonth, 0) : 0,
    );
    const opportunityPerMonth = growthCandidates[0]?.upsidePerMonth ?? 0;

    return {
      period,
      periodLabel: PERIOD_LABEL[period],
      dateRange: { from: profit.from, to: profit.to },
      currency: 'KZT',
      totals: {
        revenue: profit.revenue,
        cogs: profit.cogs,
        operatingExpenses: profit.operatingExpenses,
        netProfit: profit.netProfit,
        marginPct: profit.marginPct,
        expensesShareOfRevenuePct: profit.expensesShareOfRevenuePct,
        orders: profit.orders,
        unitsSold: profit.unitsSold,
      },
      changeVsPrevPeriodPct: profit.comparison,
      expensesByCategory: bloatingExpenseLines,
      bloatingExpenseLines: bloatingExpenseLines.filter(
        (c) => c.excessVsRevenueGrowthPerMonth > 0,
      ),
      productCount: stats.total,
      topProductsByProfit: products.slice(0, 5).map(slim),
      lossMakingProducts: losers.slice(0, 5).map((p) => ({
        ...slim(p),
        lossPerMonth: perMonth(p.profit),
      })),
      lossMakingCount: losers.length,
      totalLossPerMonth,
      highReturnProducts: products
        // Порог возвратов — общий с карточкой товара (HIGH_RETURNS_PCT).
        .filter((p) => p.returnsLevel === 'high')
        .sort((a, b) => b.returnsPct - a.returnsPct)
        .slice(0, 5)
        .map(slim),
      growthCandidates,
      // Подсказка модели, с чего начинать headline.
      leadWith: leakPerMonth >= opportunityPerMonth ? 'leak' : 'opportunity',
      biggestLeakPerMonth: leakPerMonth,
      biggestOpportunityPerMonth: opportunityPerMonth,
      top3ProfitSharePct: +top3Share.toFixed(1),
      monthly: monthly.data,
      dataQuality: profit.dataQuality,
    };
  }

  /**
   * Приводим ответ к требованиям, которые JSON Schema выразить не может:
   * «требуют действий» — максимум 3, «точки роста» — ровно 3, весь текст —
   * сплошной строкой.
   */
  private normalize(
    raw: AiInsightsPayload,
    period: AiPeriod,
  ): AiInsightsPayload {
    const item = (i: AiTextItem): AiTextItem => ({
      ...i,
      title: flatten(i.title),
      detail: flatten(i.detail),
      badge: flatten(i.badge),
      potential: flatten(i.potential),
    });

    const headlineText = flatten(raw.headline?.text);
    const verdictLabel = flatten(raw.headline?.verdict?.label);
    // Фронт подсвечивает оценку внутри текста по вхождению подстроки —
    // если модель перефразировала её, подсветить будет нечего.
    if (
      verdictLabel &&
      !headlineText.toLowerCase().includes(verdictLabel.toLowerCase())
    ) {
      this.logger.warn(
        `Verdict «${verdictLabel}» not found in headline text — it will render unhighlighted`,
      );
    }

    const growthPoints = (raw.growthPoints ?? [])
      .map(item)
      .slice(0, GROWTH_POINTS);
    if (growthPoints.length < GROWTH_POINTS) {
      // Дополнить нечем: выдумывать точку роста, которой нет в данных, хуже,
      // чем показать на карточку меньше.
      this.logger.warn(
        `Model returned ${growthPoints.length} growth points, expected ${GROWTH_POINTS}`,
      );
    }

    return {
      period: raw.period || PERIOD_LABEL[period],
      headline: {
        verdict: {
          label: verdictLabel,
          tone:
            raw.headline?.verdict?.tone === 'negative'
              ? 'negative'
              : 'positive',
        },
        text: headlineText,
        tags: (raw.headline?.tags ?? []).map((t) => ({
          label: flatten(t.label),
          tone: t.tone,
        })),
      },
      requiresAction: (raw.requiresAction ?? [])
        .map(item)
        .slice(0, MAX_ACTIONS),
      growthPoints,
      profitInsight: { text: flatten(raw.profitInsight?.text) },
      expensesInsight: { text: flatten(raw.expensesInsight?.text) },
      productsInsight: { text: flatten(raw.productsInsight?.text) },
    };
  }

  async generate(
    sellerId: string,
    userId: string,
    period: string,
    force = false,
  ) {
    if (!(AI_PERIODS as readonly string[]).includes(period)) {
      // Раньше любая строка молча превращалась в 30 дней и оседала в кеше
      // под собственным ключом — инсайт «за 90 дней» мог быть посчитан за 30.
      throw new BadRequestException(
        `Unsupported period «${period}». Use one of: ${AI_PERIODS.join(', ')}.`,
      );
    }
    const p = period as AiPeriod;
    await this.assertOwned(sellerId, userId);

    // AI insights are a Pro feature — enforced on the server so the frontend
    // gate can't be bypassed (curl/Postman) to spend on the shared OpenAI key.
    if ((await this.planOf(userId)) !== 'pro') {
      throw new ForbiddenException({
        code: 'PRO_REQUIRED',
        message: 'AI-инсайты доступны на тарифе Pro.',
      });
    }

    const [cached] = await this.db
      .select()
      .from(aiInsightsCache)
      .where(
        and(
          eq(aiInsightsCache.sellerId, sellerId),
          eq(aiInsightsCache.period, p),
        ),
      )
      .limit(1);

    // Serve the cached insight while it is fresh. A Pro "refresh" skips the
    // cache, but at most once per cooldown: without it, `force=true` in a loop
    // is a paid OpenAI call per request on our shared key, and burns the key's
    // rate limit for every other Pro customer.
    if (cached && isCurrentShape(cached.insights)) {
      const age = Date.now() - cached.generatedAt.getTime();
      if (age < CACHE_TTL_MS && (!force || age < FORCE_REFRESH_COOLDOWN_MS)) {
        return {
          generatedAt: cached.generatedAt,
          model: cached.model,
          period: p,
          insights: cached.insights,
          basedOn: cached.basedOn,
          cached: true,
          // When a refresh was asked for but is still cooling down.
          ...(force
            ? {
                refreshAvailableAt: new Date(
                  cached.generatedAt.getTime() + FORCE_REFRESH_COOLDOWN_MS,
                ),
              }
            : {}),
        };
      }
    }

    // Two requests for the same insight at once (double click, two tabs, the
    // provider mounting twice) would each pay for a generation. Share one.
    const key = `${sellerId}:${p}`;
    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.regenerate(sellerId, userId, p).finally(() =>
      this.inflight.delete(key),
    );
    this.inflight.set(key, job);
    return job;
  }

  /** One OpenAI generation for (seller, period), written through to the cache. */
  private async regenerate(sellerId: string, userId: string, p: AiPeriod) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'AI insights are not configured (missing OPENAI_API_KEY).',
      );
    }
    const model = this.config.get<string>('OPENAI_MODEL') ?? 'gpt-4o-mini';
    const context = await this.gatherContext(sellerId, userId, p);

    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(context) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'business_insights',
              strict: true,
              schema: INSIGHTS_SCHEMA,
            },
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new BadGatewayException(
        `OpenAI request failed: ${e instanceof Error ? e.message : e}`,
      );
    }

    const body = await res.text();
    if (!res.ok) {
      this.logger.warn(`OpenAI HTTP ${res.status}: ${body.slice(0, 300)}`);
      throw new BadGatewayException(`OpenAI returned HTTP ${res.status}`);
    }

    let parsed: {
      choices?: Array<{ message?: { content?: string; refusal?: string } }>;
      usage?: unknown;
    };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new BadGatewayException('OpenAI returned non-JSON');
    }
    const msg = parsed.choices?.[0]?.message;
    if (msg?.refusal) {
      throw new BadGatewayException(`OpenAI refused: ${msg.refusal}`);
    }
    let raw: AiInsightsPayload;
    try {
      raw = JSON.parse(msg?.content ?? '') as AiInsightsPayload;
    } catch {
      throw new BadGatewayException('OpenAI content was not valid JSON');
    }
    const insights = this.normalize(raw, p);

    const generatedAt = new Date();
    // Cache it so page reloads / other pages reuse it within the TTL.
    await this.db
      .insert(aiInsightsCache)
      .values({
        sellerId,
        period: p,
        model,
        insights,
        basedOn: context.totals,
        generatedAt,
      })
      .onConflictDoUpdate({
        target: [aiInsightsCache.sellerId, aiInsightsCache.period],
        set: {
          model,
          insights,
          basedOn: context.totals,
          generatedAt,
        },
      });

    return {
      generatedAt,
      model,
      period: p,
      insights,
      // Echo the numbers the insights are grounded in, for the UI/debugging.
      basedOn: context.totals,
      cached: false,
    };
  }
}
