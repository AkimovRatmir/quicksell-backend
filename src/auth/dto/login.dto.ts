import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'owner@example.kz' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'S3curePass!' })
  @IsString()
  password!: string;
}
