import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/** «Товарная статистика» query — period, filter tab, search, pagination. */
export class ProductStatsQueryDto {
  @ApiPropertyOptional({ enum: ['7d', '30d', '90d', '12m'], default: '30d' })
  @IsOptional()
  @IsIn(['7d', '30d', '90d', '12m'])
  period: string = '30d';

  @ApiPropertyOptional({
    enum: ['all', 'top', 'weak'],
    description: 'Все / Топ / Слабые',
    default: 'all',
  })
  @IsOptional()
  @IsIn(['all', 'top', 'weak'])
  filter: string = 'all';

  @ApiPropertyOptional({ description: 'Substring match on product title or SKU' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 20;
}
