import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** Update «Цели бизнеса» + the global auto-apply toggle. All fields optional. */
export class UpdateSettingsDto {
  @ApiPropertyOptional({
    description: '«Применять ко всем товарам автоматически»',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  applyExpensesAuto?: boolean;

  @ApiPropertyOptional({ description: '«Хочу зарабатывать», % of sale', example: 20 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  targetProfitPct?: number;

  @ApiPropertyOptional({ description: '«Минимум допустимый», %', example: 10 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  minProfitPct?: number;

  @ApiPropertyOptional({ description: '«Налоги» — tax rate, % of revenue', example: 3 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  taxPercent?: number;

  @ApiPropertyOptional({ description: '«Окупаемость за», months', example: 3 })
  @IsOptional()
  @IsInt()
  @Min(0)
  paybackMonths?: number;
}
