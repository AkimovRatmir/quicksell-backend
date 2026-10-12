import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { validate } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { KaspiModule } from './kaspi/kaspi.module';
import { LegalModule } from './legal/legal.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate,
    }),
    ScheduleModule.forRoot(),
    // Only the auth routes opt in (see @UseGuards(ThrottlerGuard) there): the
    // rest of the API is behind a JWT, while login and password reset are open
    // to anyone and are the ones worth guessing at.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
    DatabaseModule,
    AuthModule,
    LegalModule,
    HealthModule,
    KaspiModule,
    AnalyticsModule,
    AdminModule,
    BillingModule,
  ],
})
export class AppModule {}
