import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvVars {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsOptional()
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  /** AES key for encrypting Kaspi credentials (32-byte base64/hex, or passphrase). */
  @IsString()
  @IsNotEmpty()
  CREDENTIALS_ENC_KEY!: string;

  /** HMAC secret for signing app JWTs. */
  @IsString()
  @IsNotEmpty()
  JWT_SECRET!: string;

  /** OpenAI API key for AI insights (optional — the feature 503s without it). */
  @IsOptional()
  @IsString()
  OPENAI_API_KEY?: string;

  /** OpenAI model for AI insights. */
  @IsOptional()
  @IsString()
  OPENAI_MODEL: string = 'gpt-4o-mini';

  /**
   * Resend API key — sends the password-reset email. Optional: without it,
   * development logs the message instead of sending, production refuses.
   */
  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  /** Sender of our transactional email. Domain must be verified in Resend. */
  @IsOptional()
  @IsString()
  MAIL_FROM: string = 'QuickSell <no-reply@quicksell.kz>';

  /** Public frontend origin — the base of the password-reset link. */
  @IsOptional()
  @IsString()
  APP_BASE_URL: string = 'https://web.quicksell.kz';

  /**
   * Browser origins allowed to call this API, comma-separated. Unset falls back
   * to web.quicksell.kz in production and the Vite dev server otherwise.
   */
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** Interface to bind. Defaults to 127.0.0.1 in production, all in dev. */
  @IsOptional()
  @IsString()
  HOST?: string;

  /** '1' when nginx (or any proxy) sits in front — makes req.ip the real client. */
  @IsOptional()
  @IsString()
  TRUST_PROXY?: string;

  /**
   * HTTP Basic credentials for /docs in production. Both unset = docs are not
   * mounted at all on the server.
   */
  @IsOptional()
  @IsString()
  SWAGGER_USER?: string;

  @IsOptional()
  @IsString()
  SWAGGER_PASSWORD?: string;

  /**
   * FreedomPay shop (my.freedompay.kz → Настройки → Магазины, the number after
   * «#») and its «Секретный ключ для приема». Both unset = checkout answers 503.
   */
  @IsOptional()
  @IsString()
  FREEDOM_MERCHANT_ID?: string;

  @IsOptional()
  @IsString()
  FREEDOM_SECRET_KEY?: string;

  /** '0' takes real money. Anything else, or unset, creates test payments. */
  @IsOptional()
  @IsString()
  FREEDOM_TEST_MODE?: string;

  /** FreedomPay API host. Default https://api.freedompay.kz. */
  @IsOptional()
  @IsString()
  FREEDOM_API_URL?: string;
}

/**
 * Fail-fast env validation wired into ConfigModule.forRoot({ validate }).
 * Throws on startup if required vars are missing or malformed.
 */
export function validate(config: Record<string, unknown>): EnvVars {
  const validated = plainToInstance(EnvVars, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${errors
        .map(
          (e) =>
            `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
        )
        .join('\n')}`,
    );
  }

  return validated;
}
