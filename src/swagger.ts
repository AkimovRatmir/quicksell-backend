import { timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';

const DOCS_PATH = 'docs';
const DOCS_JSON_PATH = 'docs-json';
/** /docs, /docs/…, /docs-json, /docs-yaml — every URL the docs can live at. */
const DOCS_ROUTE = /^\/docs(?:[/-]|$)/;

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, and length alone leaks little.
  return x.length === y.length && timingSafeEqual(x, y);
}

/** HTTP Basic in front of the docs. Credentials come from the environment. */
function basicAuth(user: string, password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const [u, ...rest] = Buffer.from(encoded, 'base64')
        .toString('utf8')
        .split(':');
      if (equal(u ?? '', user) && equal(rest.join(':'), password)) {
        next();
        return;
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="quickAnalytics API docs"');
    res.status(401).send('Authentication required');
  };
}

/**
 * Mounts the API docs.
 *
 * The docs describe every route, including the admin ones and how the Kaspi
 * cabinet session works — a map worth keeping to ourselves. So in production
 * they sit behind HTTP Basic, and if no password is configured they are not
 * mounted at all: failing closed beats publishing the map by omission.
 * In development they stay open.
 */
export function setupSwagger(
  app: NestExpressApplication,
  config: ConfigService,
): void {
  const logger = new Logger('Swagger');
  const isProduction = config.get<string>('NODE_ENV') === 'production';
  const user = config.get<string>('SWAGGER_USER');
  const password = config.get<string>('SWAGGER_PASSWORD');

  if (isProduction) {
    if (!user || !password) {
      logger.warn(
        'API docs disabled: set SWAGGER_USER and SWAGGER_PASSWORD to enable them in production.',
      );
      return;
    }
    // One guard for the whole docs family. Guarding each path separately is
    // how /docs-yaml slipped through: Express matches whole path segments, so
    // app.use('/docs') never covered it, and Swagger serves that copy by
    // default. The pattern covers /docs, /docs/*, /docs-json and anything
    // shaped like them later.
    const guard = basicAuth(user, password);
    app.use((req: Request, res: Response, next: NextFunction) =>
      DOCS_ROUTE.test(req.path) ? guard(req, res, next) : next(),
    );
    logger.log('API docs mounted behind HTTP Basic auth');
  }

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('quickAnalyticsBack')
      .setDescription('QuickSell Analytics — Kaspi seller analytics API')
      .setVersion('0.0.1')
      .addTag('auth', 'Account registration & login')
      .addTag('legal', 'Legal documents & user consents')
      .addTag('kaspi', 'Kaspi seller products & sync')
      .addTag('health', 'Service & database health')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup(DOCS_PATH, app, document, {
    jsonDocumentUrl: DOCS_JSON_PATH,
    // JSON only. Nobody uses the YAML copy, and every extra endpoint is one
    // more thing the guard above has to remember.
    raw: ['json'],
  });
}
