import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // Disable Nest's built-in body parser so we can raise the JSON size limit:
  // products carry their photos inline as resized data URLs (up to 8), which
  // easily exceeds Express's ~100kb default.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    bodyParser: false,
  });
  app.use(json({ limit: '15mb' }));
  app.use(urlencoded({ extended: true, limit: '15mb' }));
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  /**
   * Behind nginx, every request arrives from the proxy, so `req.ip` reads as
   * the container's address unless Express is told how many hops to trust.
   * Anything keyed on the client IP - rate limits, the repeat-order checks -
   * would otherwise see the whole world as one address.
   *
   * The count is how many proxies sit in front. Express then takes the entry
   * that hop appended, so a client cannot forge its own X-Forwarded-For
   * without first bypassing nginx. Raise TRUST_PROXY_HOPS to 2 if a CDN is
   * added in front of it.
   */
  const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);

  const apiPrefix = config.get<string>('app.apiPrefix', 'api');
  const port = config.get<number>('app.port', 3000);
  const bindHost = config.get<string>('app.bindHost');
  const corsOrigins = config.get<string[]>('app.corsOrigins', [
    'http://localhost:5173',
  ]);
  const isProduction = config.get<string>('app.env') === 'production';

  app.setGlobalPrefix(apiPrefix);

  // Security headers. CSP is only relaxed outside production, where the
  // Swagger UI (inline scripts) is served; production keeps helmet defaults.
  app.use(helmet(isProduction ? {} : { contentSecurityPolicy: false }));

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.enableShutdownHooks();

  // OpenAPI docs at /<prefix>/docs - development tooling only, never exposed
  // in production (the spec maps the whole API surface for an attacker).
  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Hoomri API')
      .setDescription('Social SME multi-shop commerce platform API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await (bindHost ? app.listen(port, bindHost) : app.listen(port));
  logger.log(
    `Hoomri API listening on http://${bindHost ?? 'localhost'}:${port}/${apiPrefix}`,
  );
  if (!isProduction) {
    logger.log(`OpenAPI docs at http://localhost:${port}/${apiPrefix}/docs`);
  }
}

void bootstrap();
