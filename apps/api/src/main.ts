import { VersioningType, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from '@fastify/helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 8 * 1024 * 1024, // lots d'événements de synchronisation
      genReqId: () => crypto.randomUUID(),
    }),
    { bufferLogs: true },
  );

  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix(config.get<string>('API_GLOBAL_PREFIX') ?? 'api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: undefined });

  await app.register(helmet, {
    contentSecurityPolicy: false, // API JSON : pas de contenu à protéger par CSP
  });

  app.enableCors({
    origin: (config.get<string>('CORS_ORIGINS') ?? '').split(',').filter(Boolean),
    credentials: true,
  });

  // La ValidationPipe globale est déclarée dans AppModule (APP_PIPE).

  // Swagger désactivé en production : une documentation d'API exposée
  // publiquement est une carte du système offerte à un attaquant.
  if (config.get<string>('NODE_ENV') !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Phone Control API')
        .setDescription(
          'Gestion et verrouillage de téléphones Android professionnels par badge Code 128.',
        )
        .setVersion('1.0')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'admin',
        )
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          'device',
        )
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Flux temps réel du dashboard. L'adaptateur Redis permet de répliquer l'API
  // sans qu'un administrateur connecté à l'instance A manque une alerte émise
  // par l'instance B.
  const redisAdapter = new RedisIoAdapter(
    app,
    config.getOrThrow<string>('REDIS_URL'),
  );
  await redisAdapter.connect();
  app.useWebSocketAdapter(redisAdapter);

  app.enableShutdownHooks();

  const port = config.get<number>('API_PORT') ?? 3001;
  await app.listen({ port, host: '0.0.0.0' });

  logger.log(`API démarrée sur le port ${port}`);
  if (config.get<string>('NODE_ENV') !== 'production') {
    logger.log(`Documentation : http://localhost:${port}/api/docs`);
  }
}

void bootstrap();
