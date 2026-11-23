import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { AvatarCatalog } from '@shared/avatars/avatar-catalog';
import { UsersModule } from '@modules/users/users.module';
import { AvatarService } from './application/avatar.service';
import {
  AvatarsController,
  MyAvatarController,
  UserAvatarController,
} from './presentation/avatars.controller';

@Module({
  imports: [UsersModule],
  controllers: [AvatarsController, MyAvatarController, UserAvatarController],
  providers: [AvatarService],
})
export class AvatarsModule implements OnModuleInit {
  private readonly logger = new Logger(AvatarsModule.name);

  constructor(private readonly catalog: AvatarCatalog) {}

  /** Hashes the generated files at boot, so the first manifest request costs nothing. */
  onModuleInit(): void {
    const missing = this.catalog.missingFiles();
    if (missing > 0) {
      this.logger.warn(`${missing} avatar images are missing: run npm run build:avatars`);
    }
  }
}
