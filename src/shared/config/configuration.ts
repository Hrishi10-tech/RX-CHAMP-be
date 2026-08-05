
export interface AppConfig {
  env: string;
  port: number;
  apiPrefix: string;
  corsOrigins: string[];
  databaseUrl: string;
  jwt: {
    accessSecret: string;
    accessTtl: string;
    refreshSecret: string;
    refreshTtl: string;
    enrollSecret: string;
    enrollTtl: string;
  };
  security: {
    bcryptSaltRounds: number;
    rateLimitTtl: number;
    rateLimitMax: number;
  };
  defaultUserPassword: string;
  logLevel: string;
  s3: {
    bucket: string;
    region: string;
    prefix: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  agent: {
    binaryPath: string;
    fileName: string;
    version: string;
    publicApiBaseUrl: string;
  };
}

export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
    enrollSecret:
      process.env.JWT_ENROLL_SECRET ??
      `${process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh'}-enroll`,
    enrollTtl: process.env.JWT_ENROLL_TTL ?? '365d',
  },
  security: {
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12', 10),
    rateLimitTtl: parseInt(process.env.RATE_LIMIT_TTL ?? '60000', 10),
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? '120', 10),
  },
  defaultUserPassword: process.env.DEFAULT_USER_PASSWORD ?? 'changeme123',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  s3: {
    bucket: process.env.AWS_BUCKET ?? '',
    region: process.env.AWS_REGION ?? 'ap-south-1',
    prefix: process.env.AWS_PREFIX ?? 'uploads/',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
  agent: {
    binaryPath:
      process.env.AGENT_BINARY_PATH ??
      'timechamp-agent-installer/publish/RXChampAgent.exe',
    fileName: process.env.AGENT_FILE_NAME ?? 'RXChampAgent.exe',
    version: process.env.AGENT_VERSION ?? '2.0.0',
    publicApiBaseUrl:
      process.env.AGENT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1',
  },
});
