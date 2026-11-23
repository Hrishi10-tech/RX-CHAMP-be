import { Injectable } from '@nestjs/common';
import { FeatureName, resolveFlags } from './feature-flags';

/** The release flags, resolved once at boot from the environment (see feature-flags.ts). */
@Injectable()
export class FeatureFlagsService {
  private readonly flags: Record<FeatureName, boolean>;

  constructor() {
    this.flags = resolveFlags(process.env);
  }

  isOn(name: FeatureName): boolean {
    return this.flags[name];
  }

  /** Every flag and its state, for `GET /features`. */
  all(): Record<FeatureName, boolean> {
    return { ...this.flags };
  }
}
