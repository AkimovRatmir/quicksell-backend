import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * Update a seller's credentials/display name. Every field is optional — only
 * the ones you send are changed. Use this to store a rotated Kaspi API token
 * (the old one is invalidated the moment you regenerate it in the cabinet) or
 * to refresh a pasted session cookie / stored login. Secrets are re-encrypted
 * at rest and never returned.
 */
export class UpdateSellerDto {
  @ApiPropertyOptional({ example: 'Demo Store KZ', description: 'Display name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'New/rotated official Kaspi X-Auth-Token (orders sync).',
  })
  @IsOptional()
  @IsString()
  kaspiApiToken?: string;

  @ApiPropertyOptional({ description: 'New Kaspi cabinet login (products refresh).' })
  @IsOptional()
  @IsString()
  kaspiLogin?: string;

  @ApiPropertyOptional({ description: 'New Kaspi cabinet password (pairs with login).' })
  @IsOptional()
  @IsString()
  kaspiPassword?: string;

  @ApiPropertyOptional({ description: 'New pre-captured browser session cookie.' })
  @IsOptional()
  @IsString()
  kaspiSessionCookie?: string;
}
