import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBooleanString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListProductsQueryDto {
  @ApiPropertyOptional({ description: 'Substring match on title or SKU' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Filter by availability' })
  @IsOptional()
  @IsBooleanString()
  available?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'true → include archived products (those that vanished from Kaspi). Default is active only.',
  })
  @IsOptional()
  @IsBooleanString()
  archived?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
