import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { makeDb } from './database.providers';
import { DRIZZLE } from './drizzle.constants';

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        makeDb(config.getOrThrow<string>('DATABASE_URL')),
    },
  ],
  exports: [DRIZZLE],
})
export class DatabaseModule {}
