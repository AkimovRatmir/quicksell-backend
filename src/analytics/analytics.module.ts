import { Module } from '@nestjs/common';
import { AiInsightsService } from './ai-insights.service';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { UnitEconomicsService } from './unit-economics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, UnitEconomicsService, AiInsightsService],
  // KaspiService правит себестоимость одного товара и обязано попасть в ту же
  // историю, что и карточка товара — иначе правка из таблицы «Настроек» не
  // появится в «ИСТОРИИ СЕБЕСТОИМОСТИ».
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
