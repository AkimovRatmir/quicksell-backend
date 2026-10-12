import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** «Параметры товара» — inputs for a unit-economics calculation. */
export class UnitEconomicsDto {
  @ApiProperty({ description: 'Цена продажи, ₸', example: 5000 })
  @IsInt()
  @Min(0)
  salePrice!: number;

  @ApiPropertyOptional({ description: 'Себестоимость, ₸', example: 2000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  costPrice?: number = 0;

  @ApiPropertyOptional({ description: 'Комиссия Kaspi, %', example: 15 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  kaspiCommissionPct?: number = 0;

  @ApiPropertyOptional({ description: 'Доставка покупателю, ₸', example: 600 })
  @IsOptional()
  @IsInt()
  @Min(0)
  deliveryToCustomer?: number = 0;

  @ApiPropertyOptional({ description: 'Доставка до склада, ₸', example: 200 })
  @IsOptional()
  @IsInt()
  @Min(0)
  deliveryToWarehouse?: number = 0;

  @ApiPropertyOptional({ description: 'Упаковка, ₸', example: 150 })
  @IsOptional()
  @IsInt()
  @Min(0)
  packaging?: number = 0;

  @ApiPropertyOptional({ description: 'Реклама на ед., ₸', example: 300 })
  @IsOptional()
  @IsInt()
  @Min(0)
  advertisingPerUnit?: number = 0;

  @ApiPropertyOptional({ description: '% возвратов', example: 3 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  returnsPct?: number = 0;

  @ApiPropertyOptional({ description: 'Прочие расходы, ₸', example: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  otherExpenses?: number = 0;

  @ApiPropertyOptional({ description: 'Продаж в месяц, шт', example: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  salesPerMonth?: number = 0;

  @ApiPropertyOptional({ description: 'Целевая маржа, %', example: 20 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  targetMarginPct?: number = 0;
}
