import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import {
  LEGAL_DOCUMENT_CODES,
  type LegalDocumentCode,
} from '../legal-documents';

/**
 * One document the client says it displayed and the user ticked.
 *
 * Optional everywhere: when the client sends nothing, the backend records the
 * versions that are current right now. Sending it back makes the record exact —
 * if the documents were republished while the form was open, the version no
 * longer matches and the request is rejected instead of recording consent to a
 * text the user never saw.
 */
export class AcceptedDocumentDto {
  @ApiProperty({ enum: LEGAL_DOCUMENT_CODES, example: 'oferta' })
  @IsIn(LEGAL_DOCUMENT_CODES)
  code!: LegalDocumentCode;

  @ApiProperty({ example: '1.0' })
  @IsString()
  @IsNotEmpty()
  version!: string;
}
