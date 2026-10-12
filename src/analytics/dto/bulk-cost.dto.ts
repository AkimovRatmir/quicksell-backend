import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** «Быстрый старт» — apply one cost price to many products at once. */
export class BulkCostDto {
  @ApiProperty({ description: 'Cost price in tenge to apply', example: 1500 })
  @IsInt()
  @Min(0)
  cost!: number;

  @ApiPropertyOptional({
    description: 'true (default) = only products without a cost yet; false = all',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  onlyUnfilled?: boolean = true;
}

/**
 * Set each product's cost to a percentage of its OWN sale price.
 * E.g. percent=60 → a 5000 ₸ product gets cost 3000; a 900 ₸ product gets 540.
 */
export class BulkCostPercentDto {
  @ApiProperty({
    description: "Percent of each product's sale price to use as its cost",
    example: 60,
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  percent!: number;

  @ApiPropertyOptional({
    description: 'true (default) = only products without a cost yet; false = overwrite all',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  onlyUnfilled?: boolean = false;
}
