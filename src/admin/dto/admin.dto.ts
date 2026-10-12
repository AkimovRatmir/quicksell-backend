import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PLANS } from '../../database/schema';

export class UpdatePlanDto {
  @ApiProperty({ enum: PLANS, example: 'pro' })
  @IsIn(PLANS)
  plan!: (typeof PLANS)[number];
}

export class AdminUsersQueryDto {
  @ApiPropertyOptional({ description: 'Substring match on email or name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: PLANS })
  @IsOptional()
  @IsIn(PLANS)
  plan?: (typeof PLANS)[number];

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 25;
}

export class AdminSellersQueryDto {
  @ApiPropertyOptional({
    enum: ['ok', 'needs_reauth'],
    description: 'Filter by cookie status',
  })
  @IsOptional()
  @IsIn(['ok', 'needs_reauth'])
  status?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 25;
}
