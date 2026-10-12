import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsOptional, Min } from 'class-validator';

/** Новая запись в «Историю себестоимости» товара. */
export class AddCostEntryDto {
  @ApiProperty({ description: 'Себестоимость в тенге', example: 1800 })
  @IsInt()
  @Min(0)
  cost!: number;

  @ApiPropertyOptional({
    description:
      'С какой даты действует. По умолчанию — сейчас. Себестоимость применяется к заказам от этой даты, прошлые заказы считаются по предыдущей записи.',
    example: '2026-03-12T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;
}

/** Правка существующей записи истории («карандаш» в карточке). */
export class UpdateCostEntryDto {
  @ApiPropertyOptional({ description: 'Новая себестоимость в тенге', example: 1750 })
  @IsOptional()
  @IsInt()
  @Min(0)
  cost?: number;

  @ApiPropertyOptional({
    description: 'Новая дата начала действия',
    example: '2026-03-12T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;
}
