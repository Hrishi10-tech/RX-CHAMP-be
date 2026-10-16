import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import archiver from 'archiver';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { UserAccessService } from '@modules/users/domain/services/user-access.service';
import { TOKEN_SERVICE, TokenService } from '@shared/security/token.service.port';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';
import { EnvelopePayload, envelope } from '@shared/http/envelope';
import {
  DEFAULT_EXE_FILE_NAME,
  DEFAULT_ZIP_FILE_NAME,
  TRAILER_MAGIC,
} from '../application/agent.constants';
import { AgentEnrollConfig, AgentSetupCode, AgentVersionInfo } from '../application/agent.types';
import {
  AGENT_BINARY_STORES,
  AGENT_PLATFORMS,
  AgentBinaryStore,
  AgentBinaryStores,
  AgentPlatform,
  isMacPlatform,
} from '../domain/agent-binary.store';

const MAC_ZIP_FILE_NAME = 'RXVision-mac.zip';
const MAC_X64_ZIP_FILE_NAME = 'RXVision-mac-intel.zip';

/**
 * Serves the desktop agents.
 *
 * Windows (default, `?platform=windows`): with `?userId=`, the caller (that
 * user's manager, or a Super Admin) gets a copy with a per-user enrollment token
 * and server URL appended to the installer, so the employee runs it and it
 * enrolls itself. Without `userId`, the generic build is served (login screen).
 *
 * macOS (`?platform=mac`): a zipped, signed .app. Nothing is appended (that would
 * break the code signature), so Mac users sign in with email and password.
 */
@ApiTags('agent')
@ApiBearerAuth()
@Controller('agent')
export class AgentController {
  constructor(
    private readonly config: ConfigService,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(AGENT_BINARY_STORES) private readonly stores: AgentBinaryStores,
  ) {}

  private readonly access = new UserAccessService();

  private platformOf(raw?: string): AgentPlatform {
    const value = (raw ?? 'windows').toLowerCase().trim();
    const aliases: Record<string, AgentPlatform> = {
      macos: 'mac',
      darwin: 'mac',
      osx: 'mac',
      'mac-arm64': 'mac',
      'osx-arm64': 'mac',
      'mac-intel': 'mac-x64',
      'osx-x64': 'mac-x64',
      'macos-x64': 'mac-x64',
    };
    const normalised = aliases[value] ?? value;
    if (!AGENT_PLATFORMS.includes(normalised as AgentPlatform)) {
      throw new NotFoundException(`Unknown platform '${raw}'. Use windows, mac or mac-x64.`);
    }
    return normalised as AgentPlatform;
  }

  private storeFor(platform: AgentPlatform): AgentBinaryStore {
    return this.stores[platform];
  }

  @Get('version')
  @UseGuards(JwtAuthGuard)
  @ApiQuery({ name: 'platform', required: false, enum: AGENT_PLATFORMS })
  @ApiOperation({ summary: 'Agent version + whether the binary is available to download' })
  async version(
    @Query('platform') platformRaw?: string,
  ): Promise<EnvelopePayload<AgentVersionInfo>> {
    const platform = this.platformOf(platformRaw);
    const info = await this.storeFor(platform).info();
    const configured =
      platform === 'mac'
        ? this.config.get<string>('agent.mac.version')
        : platform === 'mac-x64'
          ? this.config.get<string>('agent.macX64.version')
          : this.config.get<string>('agent.version');
    return envelope<AgentVersionInfo>({
      // What the store is actually holding wins over the configured value. An
      // agent updating itself acts on this, so it has to describe the bytes it
      // would get — and it lets publishing a build be the whole release, with no
      // backend deploy to remember afterwards.
      version: info.version ?? configured ?? '',
      fileName: this.fileNameFor(platform, info.isDirectory),
      available: info.available,
      sizeBytes: info.sizeBytes,
      sha256: info.sha256 ?? '',
      platform,
    });
  }

  private fileNameFor(platform: AgentPlatform, isDirectory: boolean): string {
    if (platform === 'mac')
      return this.config.get<string>('agent.mac.fileName') || MAC_ZIP_FILE_NAME;
    if (platform === 'mac-x64')
      return this.config.get<string>('agent.macX64.fileName') || MAC_X64_ZIP_FILE_NAME;
    return (
      this.config.get<string>('agent.fileName') ||
      (isDirectory ? DEFAULT_ZIP_FILE_NAME : DEFAULT_EXE_FILE_NAME)
    );
  }

  @Get('download')
  @UseGuards(JwtAuthGuard)
  @ApiQuery({
    name: 'userId',
    required: false,
    description: "Bake this user's enrollment into the download.",
  })
  @ApiQuery({ name: 'platform', required: false, enum: AGENT_PLATFORMS })
  @ApiOperation({ summary: 'Download the agent (Windows per-user when userId is given)' })
  async download(
    @CurrentUser() me: AuthenticatedUser,
    @Res() res: Response,
    @Query('userId') userId?: string,
    @Query('platform') platformRaw?: string,
  ): Promise<void> {
    const platform = this.platformOf(platformRaw);
    const store = this.storeFor(platform);
    const info = await store.info();
    if (!info.available) {
      throw new NotFoundException(
        `The ${isMacPlatform(platform) ? 'macOS' : 'Windows'} agent is not available on the server yet.`,
      );
    }

    // Authorisation for a per-user download is checked even on Mac, where nothing
    // is baked in, so the endpoint never confirms a user id to someone outside reach.
    const config = userId ? await this.buildConfig(me, userId) : null;

    if (isMacPlatform(platform)) {
      await this.streamFile(
        res,
        store,
        info.sizeBytes,
        this.fileNameFor(platform, false),
        'application/zip',
      );
      return;
    }

    // A directory means the modern WinUI agent from a local publish folder: ship
    // the whole self-contained folder as a ZIP (its single-file exe isn't viable).
    // Otherwise — a single file on disk, or the object in S3 — stream it and append
    // the per-user config trailer.
    const dir = store.directoryPath();
    if (info.isDirectory && dir) {
      await this.downloadZip(res, dir, config);
    } else {
      await this.downloadExe(res, store, info.sizeBytes, config);
    }
  }

  @Get('setup-code')
  @UseGuards(JwtAuthGuard)
  @ApiQuery({ name: 'userId', required: true })
  @ApiOperation({
    summary:
      'A setup code for signing the agent in without a password (pasted into the ' +
      "agent's sign-in screen; used for the Mac agent). Same access rule as a per-user download.",
  })
  async setupCode(
    @CurrentUser() me: AuthenticatedUser,
    @Query('userId') userId: string,
  ): Promise<EnvelopePayload<AgentSetupCode>> {
    if (!userId) throw new NotFoundException('Pick a person.');
    const config = await this.buildConfig(me, userId);
    const payload = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
    return envelope<AgentSetupCode>({
      code: `RXV1.${payload}`,
      apiBaseUrl: config.ApiBaseUrl,
      userId,
    });
  }

  /** Streams a stored file as-is (the Mac app archive). */
  private async streamFile(
    res: Response,
    store: AgentBinaryStore,
    sizeBytes: number,
    fileName: string,
    contentType: string,
  ): Promise<void> {
    res.set({
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      ...(sizeBytes > 0 ? { 'Content-Length': sizeBytes.toString() } : {}),
    });
    const stream = await store.openStream();
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /** Streams the self-contained agent folder as a ZIP, dropping in the per-user
   *  enrollment as <c>tc-enroll.json</c> at the archive root when requested. */
  private async downloadZip(
    res: Response,
    dir: string,
    config: AgentEnrollConfig | null,
  ): Promise<void> {
    const fileName = this.config.get<string>('agent.fileName') ?? DEFAULT_ZIP_FILE_NAME;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => res.destroy());
    archive.pipe(res);
    archive.directory(dir, false); // folder contents at the archive root
    if (config) {
      archive.append(JSON.stringify(config, null, 2), { name: 'tc-enroll.json' });
    }
    await archive.finalize();
  }

  /** Streams a single-file agent (from disk or S3), appending the per-user config trailer. */
  private async downloadExe(
    res: Response,
    store: AgentBinaryStore,
    sizeBytes: number,
    config: AgentEnrollConfig | null,
  ): Promise<void> {
    const trailer = config ? this.buildTrailer(config) : Buffer.alloc(0);

    const fileName = this.config.get<string>('agent.fileName') ?? DEFAULT_EXE_FILE_NAME;
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': (sizeBytes + trailer.length).toString(),
    });

    const stream = await store.openStream();
    stream.on('error', () => res.destroy());
    stream.on('end', () => {
      if (trailer.length) res.write(trailer);
      res.end();
    });
    stream.pipe(res, { end: false });
  }

  /**
   * Resolves the per-user enrollment config (server URL + token). Allowed for
   * yourself, for a Super Admin (anyone except another Super Admin), and for a
   * Manager (their own staff). The token is a credential for that person, so the
   * same outranking rule as every other write applies.
   */
  private async buildConfig(me: AuthenticatedUser, userId: string): Promise<AgentEnrollConfig> {
    const target = await this.users.findById(userId);
    if (!target) throw new NotFoundException('User not found.');

    const self = target.id === me.id;
    const allowed =
      self ||
      (this.access.ownsTarget(me, target) &&
        !(target.role === Role.SUPER_ADMIN && me.role === Role.SUPER_ADMIN));
    if (!allowed) {
      throw new ForbiddenException('That user is not one of your reports.');
    }

    const token = await this.tokens.signEnrollmentToken(userId);
    return {
      ApiBaseUrl: this.config.get<string>('agent.publicApiBaseUrl') ?? '',
      EnrollmentToken: token,
    };
  }

  /**
   * Wraps the config as the appended exe trailer (legacy single-exe download):
   *   [configJson][uint32-LE length][8-byte magic]
   */
  private buildTrailer(config: AgentEnrollConfig): Buffer {
    const configJson = Buffer.from(JSON.stringify(config), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(configJson.length, 0);
    const magic = Buffer.from(TRAILER_MAGIC, 'ascii');
    return Buffer.concat([configJson, len, magic]);
  }
}
