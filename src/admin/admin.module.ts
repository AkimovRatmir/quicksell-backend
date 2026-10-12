import { Module } from '@nestjs/common';
import { LegalModule } from '../legal/legal.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  // The user card shows which legal documents that user accepted.
  imports: [LegalModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
