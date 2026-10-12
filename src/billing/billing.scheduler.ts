import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BillingService } from './billing.service';

/** Plan expiry and the payment safety net, every 10 minutes. */
@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);

  constructor(private readonly billing: BillingService) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'billing-housekeeping' })
  async housekeeping() {
    try {
      // Payments first: one that went through at the last minute extends the
      // plan before the expiry pass could downgrade it.
      await this.billing.reconcilePending();
      await this.billing.expirePlans();
    } catch (e) {
      this.logger.error(
        `Billing housekeeping failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}
