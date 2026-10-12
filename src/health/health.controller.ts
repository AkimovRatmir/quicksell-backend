import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDB } from '../database/drizzle.constants';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  @Get()
  @ApiOperation({ summary: 'Liveness check + database ping' })
  async check() {
    let database = 'down';
    try {
      await this.db.execute(sql`select 1`);
      database = 'up';
    } catch {
      database = 'down';
    }
    return {
      ok: database === 'up',
      database,
      timestamp: new Date().toISOString(),
    };
  }
}
