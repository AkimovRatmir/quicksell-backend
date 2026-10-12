import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { RecordConsentDto } from './dto/record-consent.dto';
import { LegalService } from './legal.service';
import { requestMeta } from './request-meta';

const DOCUMENT_EXAMPLE = {
  code: 'oferta',
  version: '1.0',
  title: 'Публичная оферта',
  url: '/docs/oferta_quicksell.pdf',
  effectiveFrom: '2026-09-20',
};

@ApiTags('legal')
@Controller('legal')
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  @Get('documents')
  @ApiOperation({
    summary: 'Current legal documents and their versions',
    description:
      'Public. The frontend links to these PDFs next to the consent checkbox and may echo the versions back when registering, so the stored consent names exactly what was displayed.',
  })
  @ApiOkResponse({ schema: { example: { documents: [DOCUMENT_EXAMPLE] } } })
  documents() {
    return { documents: this.legal.documents() };
  }

  @Get('consents')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The current user's accepted documents",
    description:
      'Returns every acceptance (newest first) plus `pending`: documents required at registration that this user has not accepted at their current version. `pending` is non-empty for accounts created before consent was collected, and after a document is republished.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        documents: [DOCUMENT_EXAMPLE],
        accepted: [
          {
            id: '4f1f0e2a-7c5a-4f6b-9a9e-0f3a1d2b3c4d',
            documentCode: 'oferta',
            documentVersion: '1.0',
            documentTitle: 'Публичная оферта',
            context: 'registration',
            acceptedAt: '2026-09-21T09:12:44.501Z',
          },
        ],
        pending: [],
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid token' })
  consents(@CurrentUser() user: AuthUser) {
    return this.legal.status(user.userId);
  }

  @Post('consents')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Record a consent for a signed-in user',
    description:
      'For checkboxes outside registration — the subscription one on the Tariff screen — and for accepting a republished document. Writes one row per document the context requires, stamped with the version, the timestamp, and the request IP / user agent.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        accepted: [
          {
            documentCode: 'oferta',
            documentVersion: '1.0',
            context: 'subscription',
            acceptedAt: '2026-09-21T09:12:44.501Z',
          },
        ],
      },
    },
  })
  @ApiConflictResponse({
    description: 'A sent document version is no longer current.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid token' })
  async record(
    @CurrentUser() user: AuthUser,
    @Body() dto: RecordConsentDto,
    @Req() req: Request,
  ) {
    const accepted = await this.legal.record({
      userId: user.userId,
      context: dto.context,
      acceptedDocuments: dto.acceptedDocuments,
      meta: requestMeta(req),
    });
    return { accepted };
  }
}
