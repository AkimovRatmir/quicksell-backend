import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { KaspiService } from './kaspi.service';

/** Hourly auto-sync of every eligible seller's Kaspi catalog and orders. */
@Injectable()
export class KaspiScheduler {
  private readonly logger = new Logger(KaspiScheduler.name);

  constructor(private readonly kaspi: KaspiService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'kaspi-auto-sync' })
  async hourlySync() {
    this.logger.log('Hourly Kaspi auto-sync starting');
    await this.kaspi.syncAllDue();
  }

  /**
   * Daily (every 24h) incremental order sync — re-pulls the last 14 days
   * (KZ return window) to catch status changes. Runs at 03:00 to avoid the
   * top-of-hour product sync.
   */
  // Pinned to Kazakhstan time: servers usually run in UTC, where "03:00"
  // would be 08:00 in Almaty — the start of the working day, not the night.
  @Cron('0 0 3 * * *', {
    name: 'kaspi-orders-auto-sync',
    timeZone: 'Asia/Almaty',
  })
  async dailyOrderSync() {
    this.logger.log('Daily Kaspi order auto-sync starting');
    await this.kaspi.syncAllOrdersDue();
  }
}
