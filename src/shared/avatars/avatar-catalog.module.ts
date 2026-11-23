import { Global, Module } from '@nestjs/common';
import { avatarCatalog, AvatarCatalog } from './avatar-catalog';

@Global()
@Module({
  providers: [{ provide: AvatarCatalog, useFactory: avatarCatalog }],
  exports: [AvatarCatalog],
})
export class AvatarCatalogModule {}
