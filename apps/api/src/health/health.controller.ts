import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { Public } from '../auth/auth.decorators';

@ApiTags('Santé')
@Controller('v1/health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Sonde de disponibilité (PostgreSQL et Redis).' })
  async check() {
    const [db, cache] = await Promise.allSettled([
      this.prisma.raw.$queryRaw`SELECT 1`,
      this.redis.client.ping(),
    ]);

    const healthy = db.status === 'fulfilled' && cache.status === 'fulfilled';

    return {
      status: healthy ? 'ok' : 'degraded',
      postgres: db.status === 'fulfilled' ? 'up' : 'down',
      redis: cache.status === 'fulfilled' ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    };
  }
}
