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

  const apiPrefix = config.get<string>('app.apiPrefix', 'api');
  const port = config.get<number>('app.port', 3000);
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

  await app.listen(port);
  logger.log(`Hoomri API listening on http://localhost:${port}/${apiPrefix}`);
  if (!isProduction) {
    logger.log(`OpenAPI docs at http://localhost:${port}/${apiPrefix}/docs`);
  }
}

void bootstrap();
