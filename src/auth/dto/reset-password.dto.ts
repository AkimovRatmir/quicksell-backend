import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'q7nT2h0m6YqVdTt1p4hWJ0m5f8Xr3sPq9cKz2bA1d0E',
    description: 'The `token` query parameter from the emailed link.',
  })
  @IsString()
  @IsNotEmpty()
  // A token is 32 bytes base64url (43 chars); the cap just stops absurd bodies.
  @MaxLength(200)
  token!: string;

  @ApiProperty({ example: 'S3curePass!', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;
}
