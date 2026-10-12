import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import {
  CONSENT_CONTEXTS,
  type ConsentContext,
  LEGAL_DOCUMENT_CODES,
} from '../legal-documents';
import { AcceptedDocumentDto } from './accepted-document.dto';

/** Records a consent for an already-registered user (subscription checkout). */
export class RecordConsentDto {
  @ApiProperty({ enum: CONSENT_CONTEXTS, example: 'subscription' })
  @IsIn(CONSENT_CONTEXTS)
  context!: ConsentContext;

  @ApiProperty({
    example: true,
    description:
      'Must be true — the user ticked the checkbox. Anything else is rejected.',
  })
  @IsBoolean()
  @Equals(true, { message: 'accepted must be true to record a consent.' })
  accepted!: boolean;

  @ApiPropertyOptional({
    type: [AcceptedDocumentDto],
    description:
      'The documents the client displayed. Omit to accept the current versions.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(LEGAL_DOCUMENT_CODES.length)
  @ValidateNested({ each: true })
  @Type(() => AcceptedDocumentDto)
  acceptedDocuments?: AcceptedDocumentDto[];
}
