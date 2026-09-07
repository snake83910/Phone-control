import { Global, Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, RateLimiterService],
  exports: [RedisService, RateLimiterService],
})
export class RedisModule {}
