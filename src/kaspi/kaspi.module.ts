import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { KaspiController } from './kaspi.controller';
import { KaspiScheduler } from './kaspi.scheduler';
import { KaspiService } from './kaspi.service';

@Module({
  imports: [AnalyticsModule],
  controllers: [KaspiController],
  providers: [KaspiService, KaspiScheduler],
})
export class KaspiModule {}
