import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/configuration';
import { GzipRequestSupport } from './common/gzip-request';
import { ScopedThrottlerGuard } from './common/scoped-throttler.guard';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuditModule } from './audit/audit.module';
import { AlertsModule } from './alerts/alerts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PushModule } from './push/push.module';
import { SettingsModule } from './settings/settings.module';
import { AuthModule } from './auth/auth.module';
import { DevicesModule } from './devices/devices.module';
import { ScreenShareModule } from './screen-share/screen-share.module';
import { AppPackagesModule } from './app-packages/app-packages.module';
import { BadgesModule } from './badges/badges.module';
import { UsersModule } from './users/users.module';
import { DepotsModule } from './depots/depots.module';
import { SessionsModule } from './sessions/sessions.module';
import { SyncModule } from './sync/sync.module';
import { HealthModule } from './health/health.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { LocationsModule } from './locations/locations.module';
import { SecurityModule } from './security/security.module';
import { CompaniesModule } from './companies/companies.module';
import { TrajelysIntegrationModule } from './integration/trajelys-integration.module';
import { RealtimeModule } from './realtime/realtime.module';
import { WorkerModule } from './worker/worker.module';
import { AccessGuard } from './auth/access.guard';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { RequestContextMiddleware } from './common/request-context.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: (config.get<number>('THROTTLE_TTL_SECONDS') ?? 60) * 1000,
            limit: config.get<number>('THROTTLE_LIMIT') ?? 120,
          },
        ],
      }),
    }),
    PrismaModule,
    RedisModule,
    CryptoModule,
    AuditModule,
    NotificationsModule,
    PushModule,
    AlertsModule,
    SettingsModule,
    AuthModule,
    DevicesModule,
    ScreenShareModule,
    AppPackagesModule,
    BadgesModule,
    UsersModule,
    DepotsModule,
    SessionsModule,
    SyncModule,
    HealthModule,
    DashboardModule,
    LocationsModule,
    SecurityModule,
    CompaniesModule,
    TrajelysIntegrationModule,
    RealtimeModule,
    // Les tâches planifiées tournent dans l'API en développement et sur les
    // petits déploiements. En production répliquée, WORKER_ENABLED=false sur
    // les instances d'API et un processus worker dédié prend le relais.
    ...(process.env.WORKER_ENABLED === 'false' ? [] : [WorkerModule]),
  ],
  providers: [
    // Décompression des lots de synchronisation compressés par les téléphones.
    // Déclarée ici, comme la ValidationPipe, pour que les tests d'intégration
    // s'exécutent contre le même comportement que la production.
    GzipRequestSupport,
    // Ordre volontaire : la limitation de débit s'applique AVANT
    // l'authentification, sinon une attaque par force brute ferait travailler
    // Argon2 à chaque tentative. Le compteur est le porteur du jeton, pas
    // l'adresse IP — voir ScopedThrottlerGuard, et le défaut qu'il corrige.
    { provide: APP_GUARD, useClass: ScopedThrottlerGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Déclarée ici plutôt que dans main.ts : la validation doit s'appliquer à
    // l'identique dans les tests d'intégration, sinon ils valident un
    // comportement que la production n'a pas.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Le contexte doit être ouvert avant les guards : c'est le guard
    // d'authentification qui y inscrit l'entreprise active.
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
