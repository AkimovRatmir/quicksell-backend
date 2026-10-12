import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserThrottlerGuard } from '../auth/user-throttler.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreateSellerDto } from './dto/create-seller.dto';
import { UpdateSellerDto } from './dto/update-seller.dto';
import { ResendOtpDto, VerifyOtpDto } from './dto/verify-otp.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { KaspiService } from './kaspi.service';

@ApiTags('kaspi')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('kaspi')
export class KaspiController {
  constructor(private readonly kaspi: KaspiService) {}

  @Post('sellers')
  // Each attempt is a login to Kaspi from our IP — cap it so the
  // endpoint can't be used to test other people's Kaspi passwords.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @ApiOperation({
    summary: 'Register a Kaspi seller (may require an email code)',
    description:
      'Recommended: send `kaspiLogin` + `kaspiPassword` — the backend logs into Kaspi headlessly (idmc → OAuth2 SSO), mints the session, and auto-derives the merchant UID. ' +
      'Kaspi now enforces device MFA: if the login needs a code, this responds `{ status: "mfa_required", pendingId, emailSentTo }` — Kaspi has emailed a 6-digit code to the seller. Collect it and POST `/kaspi/sellers/verify-code` with `{ pendingId, code }`. ' +
      'Otherwise it responds `{ status: "connected", seller }`. Verifying with "remember device" means later syncs re-auth silently — the code is asked once. A pre-captured `kaspiSessionCookie` is an optional legacy alternative (no MFA). All Kaspi secrets are AES-256-GCM encrypted at rest and never returned.',
  })
  @ApiCreatedResponse({
    description:
      '`{ status: "connected", seller }` (no secrets), or `{ status: "mfa_required", pendingId, emailSentTo }` when a code was emailed.',
    schema: {
      example: {
        status: 'connected',
        seller: {
          id: 'cc74bc8f-b68f-4828-bf2a-040a3678c729',
          userId: 'd62922a1-3ac4-4775-ab33-1f3b37a3a62e',
          name: 'Demo Store KZ',
          kaspiMerchantUid: '12345678',
          cookieStatus: 'ok',
          lastSyncAt: null,
          lastSyncError: null,
          createdAt: '2026-05-19T11:00:00.000Z',
          updatedAt: '2026-05-19T11:00:00.000Z',
        },
      },
    },
  })
  @ApiBadRequestResponse({
    description:
      'No kaspiLogin+kaspiPassword and no kaspiSessionCookie; or a multi-merchant account.',
  })
  @ApiUnauthorizedResponse({
    description: 'Kaspi rejected the login (wrong email/password).',
  })
  createSeller(@CurrentUser() user: AuthUser, @Body() dto: CreateSellerDto) {
    return this.kaspi.createSeller(user.userId, dto);
  }

  @Post('sellers/verify-code')
  // Guessing the 6-digit code happens here.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 600_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit the emailed MFA code to finish a login',
    description:
      'Completes a connect or re-auth that returned `mfa_required`. Pass the `pendingId` from that response and the 6-digit `code` from the seller’s email. On success the seller is connected and its trusted-device cookies are stored, so future syncs re-auth without a code. Returns `{ status: "connected", seller }`.',
  })
  @ApiOkResponse({ description: 'Code accepted — seller connected.' })
  @ApiBadRequestResponse({ description: 'Pending login expired or invalid.' })
  @ApiUnauthorizedResponse({ description: 'Wrong or expired code.' })
  verifyOtp(@CurrentUser() user: AuthUser, @Body() dto: VerifyOtpDto) {
    return this.kaspi.verifyOtp(user.userId, dto.pendingId, dto.code);
  }

  @Post('sellers/resend-code')
  // Every call makes Kaspi email the seller.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 600_000, limit: 3 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-send the MFA code for a pending login',
    description:
      'Asks Kaspi to email a new 6-digit code for the given `pendingId`. Rate-limited by Kaspi.',
  })
  @ApiOkResponse({ description: '`{ emailSentTo }` — a new code was sent.' })
  @ApiBadRequestResponse({
    description: 'Pending login expired, or Kaspi is rate-limiting resends.',
  })
  resendCode(@CurrentUser() user: AuthUser, @Body() dto: ResendOtpDto) {
    return this.kaspi.resendOtpCode(user.userId, dto.pendingId);
  }

  @Post('sellers/:id/reauth')
  // Runs the Kaspi password step; may email a code.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 600_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-authenticate a seller whose session/device trust expired',
    description:
      'Uses the seller’s stored login to refresh the session. If the trusted device still holds it reconnects silently (`{ status: "connected", seller }`); otherwise Kaspi emails a code and this returns `{ status: "mfa_required", pendingId, emailSentTo }` — finish with `/kaspi/sellers/verify-code`.',
  })
  @ApiOkResponse({ description: 'Reconnected, or a code was emailed.' })
  @ApiNotFoundResponse({ description: 'Seller not found.' })
  @ApiForbiddenResponse({ description: 'Not your seller.' })
  @ApiBadRequestResponse({ description: 'No stored login to re-auth with.' })
  reauth(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.kaspi.beginReauth(user.userId, id);
  }

  @Get('sellers')
  @ApiOperation({
    summary: 'List my sellers',
    description:
      'Returns only the current user’s sellers. Secrets (cookie, token, login, password) are never included.',
  })
  @ApiOkResponse({
    schema: {
      example: [
        {
          id: 'cc74bc8f-b68f-4828-bf2a-040a3678c729',
          userId: 'd62922a1-3ac4-4775-ab33-1f3b37a3a62e',
          name: 'Demo Store KZ',
          kaspiMerchantUid: '12345678',
          cookieStatus: 'ok',
          lastSyncAt: '2026-05-19T11:17:58.718Z',
          lastSyncError: null,
          createdAt: '2026-05-19T11:00:00.000Z',
          updatedAt: '2026-05-19T11:17:58.718Z',
        },
      ],
    },
  })
  listSellers(@CurrentUser() user: AuthUser) {
    return this.kaspi.listSellers(user.userId);
  }

  @Patch('sellers/:id')
  // Stored credentials are retried by the hourly sync.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @ApiOperation({
    summary: "Update a seller's credentials or name",
    description:
      'Only the fields you send are changed. Use this to store a ROTATED Kaspi API token (the old token is invalidated when you regenerate it in the cabinet) or to refresh a session cookie / login+password. Secrets are re-encrypted at rest and never returned. Storing fresh cookie/login also clears a `needs_reauth` flag.',
  })
  @ApiOkResponse({
    description: 'Updated seller (no secrets in the response).',
  })
  @ApiBadRequestResponse({ description: 'No updatable fields provided.' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  @ApiNotFoundResponse({ description: 'No seller with that id.' })
  updateSeller(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSellerDto,
  ) {
    return this.kaspi.updateSeller(id, user.userId, dto);
  }

  @Post('sellers/:id/sync')
  // Pulls the whole catalogue from Kaspi.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 12 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Pull all of a seller's Kaspi products into Postgres",
    description:
      'Fetches every offer (paged) and upserts on (seller, sku). If the session cookie is expired it auto re-logins from the stored credentials and retries once; only flags `needs_reauth` if that also fails. Also runs automatically every hour.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        sellerId: 'cc74bc8f-b68f-4828-bf2a-040a3678c729',
        total: 401,
        fetched: 401,
        upserted: 401,
        archived: 0,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'Session expired and could not be refreshed (no/invalid stored credentials) — seller flagged needs_reauth.',
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  sync(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.kaspi.syncProducts(id, user.userId);
  }

  @Post('sellers/:id/orders/backfill')
  // 89 days of orders plus one request per order.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'One-time first-login backfill of archived orders (89 days)',
    description:
      'Pulls the full 89-day ARCHIVE window (+ line items) via the official Kaspi Shop API and upserts on (seller, code). Meant to be called once by the frontend when a seller is first connected. Idempotent — safe to re-run, never creates duplicates. Requires a stored Kaspi API token.',
  })
  @ApiOkResponse({
    schema: {
      example: { sellerId: 'cc74bc8f-…', orders: 1240, entries: 1310 },
    },
  })
  @ApiBadRequestResponse({ description: 'Seller has no Kaspi API token.' })
  @ApiUnauthorizedResponse({ description: 'Kaspi rejected the API token.' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  backfillOrders(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.kaspi.backfillOrders(id, user.userId);
  }

  @Post('sellers/:id/orders/sync')
  // 14 days of orders from Kaspi.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 12 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Incremental refresh of archived orders (14 days)',
    description:
      'Re-pulls the last 14 days of ARCHIVE orders (KZ return window) so status changes (returned/cancelled) are captured, and upserts on (seller, code). While an older order still lacks its line items (a fetch failed in an earlier sync), the window widens to the full 89 days to fill them in. This is the same job the daily cron runs. Idempotent — never creates duplicates. Requires a stored Kaspi API token.',
  })
  @ApiOkResponse({
    schema: { example: { sellerId: 'cc74bc8f-…', orders: 185, entries: 210 } },
  })
  @ApiBadRequestResponse({ description: 'Seller has no Kaspi API token.' })
  @ApiUnauthorizedResponse({ description: 'Kaspi rejected the API token.' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  syncOrders(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.kaspi.syncOrders(id, user.userId);
  }

  @Get('sellers/:id/active-orders')
  // Five live Kaspi calls per request; the dashboard falls
  // back to archived orders if this is refused.
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { ttl: 600_000, limit: 30 } })
  @ApiOperation({
    summary: 'Live list of active (non-archive) orders',
    description:
      'Fetches the seller’s currently-active orders straight from Kaspi (not stored): states NEW, SIGN_REQUIRED, PICKUP, DELIVERY, KASPI_DELIVERY. Returns the orders plus a per-state count. Requires the seller’s Kaspi API token.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        totalActive: 36,
        byState: {
          NEW: 0,
          SIGN_REQUIRED: 0,
          PICKUP: 2,
          DELIVERY: 0,
          KASPI_DELIVERY: 34,
        },
        data: [
          {
            code: '1026845167',
            state: 'PICKUP',
            status: 'ACCEPTED_BY_MERCHANT',
            totalPrice: 4800,
            deliveryMode: 'DELIVERY_PICKUP',
            isKaspiDelivery: false,
            customerName: 'Аяулым',
            plannedDeliveryDate: null,
            creationDate: '2026-08-12T10:00:00.000Z',
          },
        ],
      },
    },
  })
  @ApiBadRequestResponse({ description: 'Seller has no Kaspi API token.' })
  @ApiUnauthorizedResponse({ description: 'Kaspi rejected the API token.' })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  activeOrders(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.kaspi.getActiveOrders(id, user.userId);
  }

  @Get('sellers/:id/orders')
  @ApiOperation({
    summary: 'List stored orders for a seller (paginated)',
    description:
      'Reads archived orders from Postgres (last synced). Filter by `status` (e.g. COMPLETED), `dateFrom`/`dateTo` (ISO 8601 on the order creation date). Newest first.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        total: 185,
        page: 1,
        limit: 50,
        data: [
          {
            code: '900000001',
            state: 'ARCHIVE',
            status: 'COMPLETED',
            totalPrice: 2700,
            deliveryCostForSeller: 173,
            paymentMode: 'PREPAID',
            deliveryMode: 'DELIVERY_LOCAL',
            isKaspiDelivery: true,
            customerName: 'Аяулым',
            deliveryTown: 'Алматы',
            entriesCount: 1,
            creationDate: '2026-06-27T00:18:37.179Z',
            completionDate: '2026-06-29T10:00:00.000Z',
          },
        ],
      },
    },
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  orders(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ListOrdersQueryDto,
  ) {
    return this.kaspi.listOrders(id, user.userId, q);
  }

  @Get('sellers/:id/products')
  @ApiOperation({
    summary: 'List stored products for a seller (paginated)',
    description:
      'Reads from Postgres (last synced data). Hides archived products by default — pass `archived=true` to include rows whose SKU vanished from Kaspi (their `costPrice` is preserved). Supports `search` (title/SKU), `available` (true/false), `page`, `limit` (max 200).',
  })
  @ApiOkResponse({
    schema: {
      example: {
        total: 401,
        page: 1,
        limit: 50,
        data: [
          {
            sku: '108513385_815903895',
            title: 'AirRoxy осевой 16Вт, ARC 120 S',
            brand: 'airroxy',
            masterCategory: 'Master - Exhaust fans',
            priceMin: 7000,
            priceMax: 7000,
            costPrice: 4500,
            available: true,
            totalStock: 8,
            availabilities: [
              { storeId: '12345678_PP1', stockCount: 8, available: 'yes' },
            ],
            archivedAt: null,
            kaspiUpdatedAt: '2026-05-03T02:07:10.101Z',
            syncedAt: '2026-05-19T11:17:58.718Z',
          },
        ],
      },
    },
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  products(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ListProductsQueryDto,
  ) {
    return this.kaspi.listProducts(id, user.userId, q);
  }

  @Patch('sellers/:id/products/:sku')
  @ApiOperation({
    summary: 'Update user-editable product fields',
    description:
      'Currently supports `costPrice` (seller-supplied COGS). Persists across Kaspi syncs. Pass `null` to clear.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        sku: '108513385_815903895',
        title: 'AirRoxy осевой 16Вт, ARC 120 S',
        priceMin: 7000,
        costPrice: 4500,
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'No product with that SKU for this seller.',
  })
  @ApiForbiddenResponse({ description: 'Seller belongs to another user.' })
  updateProduct(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sku') sku: string,
    @Body() dto: UpdateProductDto,
  ) {
    // Omitted and null are different requests: null clears the cost on purpose,
    // omitted means "nothing to change". Folding both into null turned an empty
    // body into a silent wipe of the cost and its entire history.
    if (dto.costPrice === undefined) {
      throw new BadRequestException('No updatable fields provided.');
    }
    return this.kaspi.updateCostPrice(id, user.userId, sku, dto.costPrice);
  }
}
