import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export const EXPENSE_KINDS = ['percent', 'fixed'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export class CreateExpenseCategoryDto {
  @ApiProperty({ example: 'Комиссия Kaspi' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    enum: EXPENSE_KINDS,
    description: "'percent' → % of sale price; 'fixed' → tenge per unit",
    example: 'percent',
  })
  @IsIn(EXPENSE_KINDS)
  kind!: ExpenseKind;

  @ApiProperty({ description: '15 = 15% (percent) or 150 = 150 ₸ (fixed)', example: 15 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  value!: number;

  @ApiPropertyOptional({ description: 'UI dot color (hex)', example: '#6C5CE7' })
  @IsOptional()
  @IsString()
  color?: string;
}

export class UpdateExpenseCategoryDto {
  @ApiPropertyOptional({ example: 'Комиссия Kaspi' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ enum: EXPENSE_KINDS })
  @IsOptional()
  @IsIn(EXPENSE_KINDS)
  kind?: ExpenseKind;

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  value?: number;

  @ApiPropertyOptional({ example: '#6C5CE7' })
  @IsOptional()
  @IsString()
  color?: string;
}
