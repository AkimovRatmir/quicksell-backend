import { Module } from '@nestjs/common';
import { LegalController } from './legal.controller';
import { LegalService } from './legal.service';

@Module({
  controllers: [LegalController],
  providers: [LegalService],
  // AuthService records the registration consent in the same transaction that
  // creates the user, so it needs the service, not just the endpoint.
  exports: [LegalService],
})
export class LegalModule {}
