import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AlertsModule } from '../alerts/alerts.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminAuthService } from './admin-auth.service';
import { TrajelysSsoService } from './trajelys-sso.service';
import { BarcodeAuthService } from './barcode-auth.service';
import { AuthController } from './auth.controller';
import { DeviceTokenService } from './device-token.service';

@Module({
  imports: [JwtModule.register({}), AlertsModule, SettingsModule],
  controllers: [AuthController],
  providers: [
    AdminAuthService,
    BarcodeAuthService,
    DeviceTokenService,
    TrajelysSsoService,
  ],
  exports: [DeviceTokenService, JwtModule],
})
export class AuthModule {}
