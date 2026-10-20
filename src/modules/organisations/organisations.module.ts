import { Module } from '@nestjs/common';
import { SettingsModule } from '@modules/settings/settings.module';
import { ORGANISATION_STORE } from './domain/organisation.store';
import { PrismaOrganisationStore } from './infrastructure/prisma-organisation.store';
import { OrganisationsService } from './application/organisations.service';
import {
  OrganisationsController,
  PlatformOverviewController,
} from './presentation/organisations.controller';

/** Organisations and the platform overview (docs/4.0/SPEC.md 5.1). */
@Module({
  imports: [SettingsModule],
  controllers: [OrganisationsController, PlatformOverviewController],
  providers: [
    { provide: ORGANISATION_STORE, useClass: PrismaOrganisationStore },
    OrganisationsService,
  ],
  exports: [OrganisationsService],
})
export class OrganisationsModule {}
