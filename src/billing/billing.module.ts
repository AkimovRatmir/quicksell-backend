import { Module } from '@nestjs/common';
import { LegalModule } from '../legal/legal.module';
import { BillingController } from './billing.controller';
import { BillingScheduler } from './billing.scheduler';
import { BillingService } from './billing.service';
import { FreedomPayClient } from './freedompay.client';

@Module({
  // Checkout refuses to start until the subscription consent is on record.
  imports: [LegalModule],
  controllers: [BillingController],
  providers: [BillingService, BillingScheduler, FreedomPayClient],
})
export class BillingModule {}
