import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { setupSwagger } from './swagger';

/** Browser origins allowed to call the API, from CORS_ORIGINS (comma-separated). */
function corsOrigins(config: ConfigService): string[] {
  const raw = config.get<string>('CORS_ORIGINS');
  if (raw?.trim()) {
    return raw
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean);
  }
  return config.get<string>('NODE_ENV') === 'production'
    ? ['https://web.quicksell.kz']
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Today the frontend calls /api on its own origin (nginx forwards it here),
  // so browsers never need CORS. This allowlist is what makes a split
  // api.* domain work later — and what refuses every other site meanwhile.
  // The token travels in the Authorization header, not a cookie, so
  // credentials stay off.
  const origins = corsOrigins(config);
  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    // X-Skip-Auth-Redirect: the frontend marks Kaspi calls whose 401 means
    // "Kaspi rejected the seller", not "our session expired". Same-origin
    // today, but without it a split api.* domain would block those calls.
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Skip-Auth-Redirect'],
    maxAge: 86_400,
  });

  // Behind nginx every request appears to come from 127.0.0.1. Turning this on
  // makes Express read the forwarded address instead, which is what we record
  // as evidence on consents and password resets. Only enable it when a proxy
  // really is in front — otherwise clients could forge the header themselves.
  if (config.get<string>('TRUST_PROXY') === '1') {
    app.set('trust proxy', 1);
  }

  app.enableShutdownHooks();
  setupSwagger(app, config);

  // In production nginx is the only thing that should reach the API, so bind
  // to loopback. On every interface, anyone able to reach :3000 directly
  // could set X-Forwarded-For themselves (TRUST_PROXY is on) and dodge the
  // per-IP limits or forge the IP recorded on consents. Dev keeps the default
  // so the Vite proxy works whichever way `localhost` resolves.
  const port = config.get<number>('PORT') ?? 3000;
  const host =
    config.get<string>('HOST') ??
    (config.get<string>('NODE_ENV') === 'production' ? '127.0.0.1' : undefined);
  if (host) await app.listen(port, host);
  else await app.listen(port);
  new Logger('Bootstrap').log(
    `Listening on ${host ?? '*'}:${port} — CORS: ${origins.join(', ')}`,
  );
}

void bootstrap();
