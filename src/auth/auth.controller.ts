import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { requestMeta } from '../legal/request-meta';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordResetService } from './password-reset.service';
import type { AuthUser } from './jwt.strategy';

const AUTH_RESULT_EXAMPLE = {
  accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  user: {
    id: 'd62922a1-3ac4-4775-ab33-1f3b37a3a62e',
    email: 'owner@example.kz',
    name: 'Max',
  },
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly reset: PasswordResetService,
  ) {}

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @ApiOperation({
    summary: 'Create an analytics account',
    description:
      'Registers a user (password stored as a one-way scrypt hash) and returns a 7-day JWT. Use the token as `Authorization: Bearer <token>` for all /kaspi routes.',
  })
  @ApiCreatedResponse({ schema: { example: AUTH_RESULT_EXAMPLE } })
  @ApiConflictResponse({
    description:
      'Email already registered, or a sent document version is no longer current.',
  })
  @ApiBadRequestResponse({
    description: 'Validation failed — including `acceptedTerms` not true.',
  })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, requestMeta(req));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Password guessing happens here. 10 attempts per minute per IP is invisible
  // to someone who mistyped and useless to someone working through a list.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Log in — returns a JWT access token',
    description:
      'Returns a 7-day JWT for the given email/password. Rate-limited to 10 attempts per minute per IP.',
  })
  @ApiOkResponse({ schema: { example: AUTH_RESULT_EXAMPLE } })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials' })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  // The per-account limit lives in the service; this one stops a single source
  // from spraying many different addresses.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @ApiOperation({
    summary: 'Send a password-reset link',
    description:
      'Emails a one-time link valid for 30 minutes. Always answers 200 with the same message, whether or not the address is registered — otherwise this endpoint would tell anyone which emails have accounts. Rate-limited per account (1 per minute, 5 per hour); requests over the limit get the same answer and no email.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        message:
          'Если аккаунт с таким адресом существует, мы отправили на него письмо со ссылкой для восстановления пароля.',
      },
    },
  })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.reset.request(dto.email, requestMeta(req));
  }

  @Get('reset-password')
  @ApiOperation({
    summary: 'Is a reset link still valid?',
    description:
      'Lets the reset page say “ссылка устарела” before asking for a new password. Returns `{ valid: false }` for anything unknown, used or expired.',
  })
  @ApiOkResponse({ schema: { example: { valid: true } } })
  checkResetToken(@Query('token') token: string) {
    return this.reset.check(token ?? '');
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary: 'Set a new password using the emailed token',
    description:
      'Spends the token (single use) and replaces the password. Every other outstanding reset link for that account stops working, and sessions issued before the reset are refused, so an old login cannot survive it.',
  })
  @ApiOkResponse({
    schema: {
      example: { message: 'Пароль изменён. Войдите с новым паролем.' },
    },
  })
  @ApiBadRequestResponse({
    description:
      'Token unknown, already used or expired; or password too short.',
  })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.reset.reset(dto.token, dto.password);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Current user profile (email, name, plan)',
    description:
      'Returns the authenticated user’s id, email, name, and subscription plan. Use it to refresh the plan after an upgrade without re-logging in.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'd62922a1-3ac4-4775-ab33-1f3b37a3a62e',
        email: 'owner@example.kz',
        name: 'Max',
        plan: 'free',
        createdAt: '2026-07-14T07:00:00.000Z',
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid token' })
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.userId);
  }
}
