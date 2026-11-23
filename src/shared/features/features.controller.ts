import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../rbac/jwt-auth.guard';
import { envelope } from '../http/envelope';
import { FeatureFlagsService } from './feature-flags.service';

@ApiTags('features')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('features')
export class FeaturesController {
  constructor(private readonly features: FeatureFlagsService) {}

  @Get()
  @ApiOperation({ summary: 'Release feature flags and their state (any signed-in role)' })
  list() {
    return envelope({ flags: this.features.all() });
  }
}
