import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

export class UpdateProductDto {
  /**
   * Seller's cost of goods sold (in tenge). Pass an integer ≥ 0 to set it,
   * pass `null` to clear it. Omit the field to leave it unchanged.
   */
  @ApiPropertyOptional({
    example: 4500,
    minimum: 0,
    nullable: true,
    description: 'Cost of goods sold (tenge). null clears it.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  costPrice?: number | null;
}
