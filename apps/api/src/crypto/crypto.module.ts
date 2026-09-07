import { Global, Module } from '@nestjs/common';
import { BadgeCipherService } from './badge-cipher.service';
import { BadgeHashService } from './badge-hash.service';
import { TokenService } from './token.service';

@Global()
@Module({
  providers: [BadgeCipherService, BadgeHashService, TokenService],
  exports: [BadgeCipherService, BadgeHashService, TokenService],
})
export class CryptoModule {}
