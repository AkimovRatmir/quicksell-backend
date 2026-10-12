import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AcceptedDocumentDto } from '../../legal/dto/accepted-document.dto';
import { LEGAL_DOCUMENT_CODES } from '../../legal/legal-documents';

export class RegisterDto {
  @ApiProperty({ example: 'owner@example.kz' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'S3curePass!', minLength: 8 })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({ example: 'Max' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  /**
   * The signup checkbox. Required and must be `true`: registration without
   * accepting the Public Offer and the Privacy Policy is refused, so no
   * account can exist without a consent record behind it.
   */
  @ApiProperty({
    example: true,
    description:
      'Must be true — the user ticked «Я принимаю условия Публичной оферты …». Registration is rejected otherwise.',
  })
  @IsBoolean()
  @Equals(true, {
    message:
      'You must accept the Public Offer and the Privacy Policy to register.',
  })
  acceptedTerms!: boolean;

  @ApiPropertyOptional({
    type: [AcceptedDocumentDto],
    description:
      'Optional. The document versions the signup form displayed, from GET /legal/documents. Omit to accept whatever is current; send them to be told (409) if the documents changed while the form was open.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LEGAL_DOCUMENT_CODES.length)
  @ValidateNested({ each: true })
  @Type(() => AcceptedDocumentDto)
  acceptedDocuments?: AcceptedDocumentDto[];
}
