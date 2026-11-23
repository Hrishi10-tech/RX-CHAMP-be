import { Global, Module } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';
import { FeaturesController } from './features.controller';
import { FeatureGuard } from './require-feature';

@Global()
@Module({
  controllers: [FeaturesController],
  providers: [FeatureFlagsService, FeatureGuard],
  exports: [FeatureFlagsService, FeatureGuard],
})
export class FeaturesModule {}
