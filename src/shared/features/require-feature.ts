import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { NotFoundError } from '../exceptions/app.exception';
import { FeatureName } from './feature-flags';
import { FeatureFlagsService } from './feature-flags.service';

export const FEATURE_KEY = 'rxv:feature';

/** Answers 404 FEATURE_OFF while the named release flag is off. */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly features: FeatureFlagsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const name = this.reflector.getAllAndOverride<FeatureName | undefined>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (name && !this.features.isOn(name)) {
      throw new NotFoundError('This feature is not switched on', 'FEATURE_OFF');
    }
    return true;
  }
}

/** Puts a controller or a route behind a release flag (404 FEATURE_OFF while it is off). */
export function RequireFeature(name: FeatureName) {
  return applyDecorators(SetMetadata(FEATURE_KEY, name), UseGuards(FeatureGuard));
}
