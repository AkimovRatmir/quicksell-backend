import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateSellerDto {
  @ApiProperty({ example: 'Demo Store KZ', description: 'Display name' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    example: '12345678',
    description:
      'Optional override. Normally auto-derived from the session cookie — only set this for multi-merchant accounts.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kaspiMerchantUid?: string;

  @ApiPropertyOptional({
    example: 'max@example.com',
    description:
      'RECOMMENDED. Kaspi cabinet login. With kaspiPassword the backend logs in headlessly, mints the session, auto-derives the UID, and auto-refreshes on expiry. Encrypted at rest.',
  })
  @IsOptional()
  @IsString()
  kaspiLogin?: string;

  @ApiPropertyOptional({
    description: 'RECOMMENDED. Kaspi cabinet password (pairs with kaspiLogin). Encrypted at rest.',
  })
  @IsOptional()
  @IsString()
  kaspiPassword?: string;

  @ApiPropertyOptional({
    description:
      'Legacy/optional. A pre-captured browser Cookie header (mc-sid & mc-session). Only needed if you are not supplying login+password. Encrypted at rest.',
  })
  @IsOptional()
  @IsString()
  kaspiSessionCookie?: string;

  @ApiPropertyOptional({
    description: 'Official Kaspi X-Auth-Token (future orders/sales). Encrypted at rest.',
  })
  @IsOptional()
  @IsString()
  kaspiApiToken?: string;
}
