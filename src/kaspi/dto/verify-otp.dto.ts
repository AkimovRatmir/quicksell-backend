import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, Length, Matches } from 'class-validator';

export class VerifyOtpDto {
  @ApiProperty({
    description: 'The `pendingId` returned by the connect/reauth call.',
    format: 'uuid',
  })
  @IsUUID()
  pendingId!: string;

  @ApiProperty({
    example: '123456',
    description: 'The 6-digit code Kaspi emailed to the seller.',
  })
  @IsString()
  @IsNotEmpty()
  @Length(4, 8)
  @Matches(/^\d+$/, { message: 'code must be digits only' })
  code!: string;
}

export class ResendOtpDto {
  @ApiProperty({
    description: 'The `pendingId` to resend a code for.',
    format: 'uuid',
  })
  @IsUUID()
  pendingId!: string;
}
