import { Global, Module } from '@nestjs/common';
import { MemoryCacheService } from './memory-cache.service';
import { CACHE_SERVICE } from './cache.port';

@Global()
@Module({
  providers: [MemoryCacheService, { provide: CACHE_SERVICE, useExisting: MemoryCacheService }],
  exports: [CACHE_SERVICE, MemoryCacheService],
})
export class CacheModule {}
