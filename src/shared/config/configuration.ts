export interface AppConfig {
  env: string;
  port: number;
  /**
   * The business timezone: the one working days are measured in and the one times
   * are shown in. Set it explicitly rather than inheriting the host's clock —
   * servers run UTC, which had "signed off at 6:38 PM" reaching a manager as
   * "1:08 PM".
   */
  timezone: string;
  apiPrefix: string;
  corsOrigins: string[];
  /**
   * The portal's public address, which 3.1 agents open for "Open approvals".
   * Falls back to the first CORS_ORIGINS entry when unset.
   */
  portalPublicUrl: string;
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
    /**
     * An S3-compatible endpoint instead of AWS (MinIO, a local test server). Empty:
     * AWS itself. `forcePathStyle` goes with it for most such servers.
     */
    endpoint: string;
    forcePathStyle: boolean;
  };
  /** Screenshot reports and monthly archives (3.2). */
  exports: {
    /** Days a finished report or archive file stays downloadable. */
    retentionDays: number;
  };
  /** Screenshot text search reads captures with AWS Textract; `false` stops those calls (3.6). */
  ocr: {
    enabled: boolean;
  };
  agent: {
    binaryPath: string;
    /** S3 object key for the agent binary; when set, it's served from S3 not disk. */
    s3Key: string;
    /** Bucket holding the agent binary; defaults to the screenshots bucket. */
    s3Bucket: string;
    fileName: string;
    version: string;
    publicApiBaseUrl: string;
    /** The macOS agent for Apple Silicon (a zipped .app), served alongside the Windows installer. */
    mac: {
      s3Key: string;
      binaryPath: string;
      fileName: string;
      version: string;
    };
    /** The macOS agent for Intel Macs. */
    macX64: {
      s3Key: string;
      binaryPath: string;
      fileName: string;
      version: string;
    };
  };
}

export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Kolkata',
  apiPrefix: process.env.API_PREFIX ?? 'api/v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  portalPublicUrl: process.env.PORTAL_PUBLIC_URL?.trim() ?? '',
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'change-me-access',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'change-me-refresh',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '7d',
    // `||`, not `??`: an empty JWT_ENROLL_SECRET= must mean "not set". An empty
    // secret would make @nestjs/jwt fall back to the access secret, and installer
    // tokens would then be signed like access tokens.
    enrollSecret:
      process.env.JWT_ENROLL_SECRET?.trim() ||
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
    endpoint: process.env.AWS_S3_ENDPOINT?.trim() ?? '',
    forcePathStyle: (process.env.AWS_S3_FORCE_PATH_STYLE ?? '').trim().toLowerCase() === 'true',
  },
  exports: {
    retentionDays: Math.max(
      1,
      parseInt(process.env.SCREENSHOT_EXPORT_RETENTION_DAYS ?? '7', 10) || 7,
    ),
  },
  ocr: {
    enabled: (process.env.OCR_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  },
  agent: {
    // `||`, not `??`: an empty AGENT_BINARY_PATH= must mean "not set", never the
    // working directory (which the download route would then serve as a zip).
    binaryPath:
      process.env.AGENT_BINARY_PATH?.trim() || 'timechamp-agent-installer/publish/RXChampAgent.exe',
    s3Key: process.env.AGENT_S3_KEY ?? '',
    s3Bucket: process.env.AGENT_S3_BUCKET ?? '',
    fileName: process.env.AGENT_FILE_NAME ?? 'RXVision.exe',
    version: process.env.AGENT_VERSION ?? '2.0.0',
    publicApiBaseUrl: process.env.AGENT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1',
    mac: {
      s3Key: process.env.AGENT_MAC_S3_KEY ?? '',
      binaryPath:
        process.env.AGENT_MAC_BINARY_PATH ?? 'timechamp-agent-mac/publish/RXVision-mac.zip',
      fileName: process.env.AGENT_MAC_FILE_NAME ?? 'RXVision-mac.zip',
      version: process.env.AGENT_MAC_VERSION ?? '',
    },
    macX64: {
      s3Key: process.env.AGENT_MAC_X64_S3_KEY ?? '',
      binaryPath:
        process.env.AGENT_MAC_X64_BINARY_PATH ??
        'timechamp-agent-mac/publish/RXVision-mac-intel.zip',
      fileName: process.env.AGENT_MAC_X64_FILE_NAME ?? 'RXVision-mac-intel.zip',
      version: process.env.AGENT_MAC_X64_VERSION ?? process.env.AGENT_MAC_VERSION ?? '',
    },
  },
});
