import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  validateSync,
} from 'class-validator';
import { isValidTimezone } from '@shared/utils/timezone';

class EnvVars {
  @IsIn(['development', 'test', 'production'])
  @IsOptional()
  NODE_ENV?: string;

  @IsNumberString()
  @IsOptional()
  PORT?: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET!: string;
}

const KNOWN_INSECURE = new Set(['change-me-access', 'change-me-refresh', 'changeme', 'secret']);

/**
 * Problems that must stop the boot, and risks to shout about without stopping
 * it (so a deploy never fails on a soft setting, but nobody misses it).
 */
export function environmentProblems(config: Record<string, unknown>): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const str = (k: string) => (typeof config[k] === 'string' ? (config[k] as string).trim() : '');
  const production = str('NODE_ENV') === 'production';

  const tz = str('APP_TIMEZONE');
  if (tz && !isValidTimezone(tz))
    errors.push(`APP_TIMEZONE '${tz}' is not a known IANA timezone (e.g. Asia/Kolkata)`);

  for (const k of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_ENROLL_SECRET']) {
    const v = str(k);
    if (!v) continue;
    // "change-me-..." covers every placeholder in .env.example, so a copied example
    // file can never boot in production.
    if (production && (KNOWN_INSECURE.has(v) || v.toLowerCase().startsWith('change-me')))
      errors.push(`${k} is a published placeholder; generate a real secret`);
    else if (production && v.length < 32) warnings.push(`${k} is shorter than 32 characters`);
  }
  if (
    production &&
    str('JWT_ENROLL_SECRET') &&
    str('JWT_ENROLL_SECRET') === str('JWT_ACCESS_SECRET')
  ) {
    // Installer tokens would then also verify as access tokens' siblings; keep them apart.
    errors.push('JWT_ENROLL_SECRET must differ from JWT_ACCESS_SECRET');
  }
  if (
    production &&
    str('JWT_ACCESS_SECRET') &&
    str('JWT_ACCESS_SECRET') === str('JWT_REFRESH_SECRET')
  ) {
    warnings.push(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are the same; use two different secrets',
    );
  }
  if (production && !str('JWT_ENROLL_SECRET')) {
    warnings.push(
      'JWT_ENROLL_SECRET is not set; installer tokens are derived from JWT_REFRESH_SECRET and break whenever it rotates',
    );
  }
  const cors = str('CORS_ORIGINS');
  if (
    production &&
    (!cors ||
      cors
        .split(',')
        .map((s) => s.trim())
        .includes('*'))
  ) {
    warnings.push(
      "CORS_ORIGINS is unset or '*'; set it to the portal origin(s), e.g. https://vision.example.com",
    );
  }
  if (production && str('SEED_DEMO_DATA') === 'true') {
    warnings.push(
      'SEED_DEMO_DATA=true in production: demo accounts with published passwords may exist',
    );
  }
  return { errors, warnings };
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvVars, config, { enableImplicitConversion: true });
  const errors = validateSync(validated, { skipMissingProperties: false });
  const extra = environmentProblems(config);
  const messages = [
    ...errors.map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`),
    ...extra.errors.map((m) => `  - ${m}`),
  ];
  if (messages.length > 0) {
    throw new Error(`Invalid environment configuration:\n${messages.join('\n')}`);
  }
  for (const w of extra.warnings) console.warn(`[config] WARNING: ${w}`);
  return config;
}
