import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { NoFilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { UserThrottlerGuard } from '../auth/user-throttler.guard';
import { BillingService } from './billing.service';
import type { FreedomFields } from './freedompay.client';

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('checkout')
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { ttl: 600_000, limit: 10 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start paying for Pro (15 000 ₸ / month)',
    description:
      'Creates the payment at FreedomPay and returns the URL of their payment form, which the frontend shows in a popup. Requires the subscription consent (POST /legal/consents, context "subscription") to be recorded first.',
  })
  @ApiCreatedResponse({
    schema: {
      example: {
        paymentId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        paymentUrl: 'https://customer.freedompay.kz/pay.html?customer=…',
        amount: 15000,
        currency: 'KZT',
      },
    },
  })
  @ApiForbiddenResponse({ description: 'Subscription consent not recorded' })
  @ApiConflictResponse({
    description: 'Account already has Pro with no end date',
  })
  @ApiServiceUnavailableResponse({
    description: 'FreedomPay not configured or unreachable',
  })
  checkout(@CurrentUser() user: AuthUser) {
    return this.billing.checkout(user.userId);
  }

  @Get('payments/:id')
  @UseGuards(JwtAuthGuard, UserThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'State of one of my payments',
    description:
      "Polled by the payment popup. While the payment is pending, the backend asks FreedomPay directly, so the answer doesn't depend on their callback having arrived. `status`: pending | paid | failed.",
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        status: 'paid',
        amount: 15000,
        currency: 'KZT',
        paidAt: '2026-09-28T10:15:00.000Z',
        paidUntil: '2026-10-28T10:15:00.000Z',
        failureReason: null,
        createdAt: '2026-09-28T10:13:41.000Z',
      },
    },
  })
  @ApiNotFoundResponse({ description: 'No such payment for this user' })
  payment(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.billing.paymentOf(user.userId, id);
  }

  /**
   * FreedomPay → us, server to server. Public by necessity (their servers
   * can't log in); trusted only through the pg_sig check in the service.
   * They post form fields, urlencoded or multipart — NoFilesInterceptor
   * parses the multipart case.
   */
  @Post('freedom/result')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(NoFilesInterceptor())
  @Header('Content-Type', 'application/xml; charset=utf-8')
  @ApiOperation({
    summary: 'FreedomPay result callback (for FreedomPay only)',
    description:
      'Signed notification of a payment outcome. Answers with signed XML. A bad signature gets 400, so FreedomPay retries while a misconfiguration is fixed.',
  })
  async freedomResult(
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const fields: FreedomFields = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (typeof v === 'string') fields[k] = v;
    }
    const { valid, xml } = await this.billing.handleResult(fields);
    if (!valid) res.status(HttpStatus.BAD_REQUEST);
    return xml;
  }
}
