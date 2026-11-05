import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import archiver from 'archiver';
import { randomBytes } from 'crypto';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { NotFoundError } from '@shared/exceptions/app.exception';
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
/** How long a direct-download link from POST /agent/download-ticket stays valid. */
const DOWNLOAD_TICKET_TTL_MS = 60_000;

/**
 * Serves the desktop agents.
 *
 * Windows (default, `?platform=windows`): with `?userId=`, the caller (that
 * person themselves, their organisation's Admin, or a Super Admin) gets a copy with a per-user enrollment token
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
    private readonly audit: AuditLogService,
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
    await this.serve(me, res, userId, platformRaw);
  }

  /**
   * A one-minute, single-use link to download the agent straight from the API host.
   *
   * The portal is served through a host (AWS Amplify) that refuses responses over a
   * few MB (413), so the installer cannot come back through the portal's /api proxy.
   * The page asks for a ticket here (a small JSON reply, through the proxy, with the
   * sign-in cookie), then opens the returned URL, which the browser fetches from the
   * API host directly. Access is checked now, exactly as for a download, and again
   * when the ticket is used.
   */
  @Post('download-ticket')
  @UseGuards(JwtAuthGuard)
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'platform', required: false, enum: AGENT_PLATFORMS })
  @ApiOperation({ summary: 'A one-minute link to download the agent from the API host directly' })
  async downloadTicket(
    @CurrentUser() me: AuthenticatedUser,
    @Query('userId') userId?: string,
    @Query('platform') platformRaw?: string,
  ): Promise<EnvelopePayload<{ url: string; expiresInSec: number }>> {
    const platform = this.platformOf(platformRaw);
    const info = await this.storeFor(platform).info();
    if (!info.available) {
      throw new NotFoundException(
        `The ${isMacPlatform(platform) ? 'macOS' : 'Windows'} agent is not available on the server yet.`,
      );
    }
    if (userId) await this.buildConfig(me, userId);

    this.sweepTickets();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, {
      me,
      userId: userId || undefined,
      platform,
      expiresAt: Date.now() + DOWNLOAD_TICKET_TTL_MS,
    });
    const base = (this.config.get<string>('agent.publicApiBaseUrl') ?? '').replace(/\/+$/, '');
    // Without a public API URL configured, fall back to the proxied path (works
    // locally; large files may still be refused by a size-limited host).
    const path = `/agent/download/direct?ticket=${encodeURIComponent(ticket)}`;
    return envelope({
      url: base ? `${base}${path}` : `/api/v1${path}`,
      expiresInSec: DOWNLOAD_TICKET_TTL_MS / 1000,
    });
  }

  /** The download behind a ticket from POST /agent/download-ticket (no cookie needed). */
  @Get('download/direct')
  @ApiQuery({ name: 'ticket', required: true })
  @ApiOperation({ summary: 'Download the agent with a ticket (opened by the browser directly)' })
  async downloadDirect(@Res() res: Response, @Query('ticket') ticket?: string): Promise<void> {
    const entry = ticket ? this.tickets.get(ticket) : undefined;
    // Single use: gone the moment it is presented, valid or not.
    if (ticket) this.tickets.delete(ticket);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new ForbiddenException(
        'This download link has expired. Go back to the portal and download again.',
      );
    }
    await this.serve(entry.me, res, entry.userId, entry.platform);
  }

  /** Outstanding download tickets (one API instance: ecosystem.config.js runs one). */
  private readonly tickets = new Map<
    string,
    { me: AuthenticatedUser; userId?: string; platform: AgentPlatform; expiresAt: number }
  >();

  private sweepTickets(): void {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expiresAt < now) this.tickets.delete(k);
  }

  private async serve(
    me: AuthenticatedUser,
    res: Response,
    userId: string | undefined,
    platformRaw: string | undefined,
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
    // A per-user Windows download is named after that person
    // ("RXVision-Praveen-V-S.exe"): the browser now saves it straight from this
    // response, so the name has to come from here, not from the portal.
    const person = config && userId ? await this.users.findById(userId) : null;
    const dir = store.directoryPath();
    if (info.isDirectory && dir) {
      const base = this.config.get<string>('agent.fileName') ?? DEFAULT_ZIP_FILE_NAME;
      await this.downloadZip(res, dir, config, personalFileName(base, person?.name));
    } else {
      const base = this.config.get<string>('agent.fileName') ?? DEFAULT_EXE_FILE_NAME;
      await this.downloadExe(
        res,
        store,
        info.sizeBytes,
        config,
        personalFileName(base, person?.name),
      );
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
    fileName: string,
  ): Promise<void> {
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
    fileName: string,
  ): Promise<void> {
    const trailer = config ? this.buildTrailer(config) : Buffer.alloc(0);

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
   * Resolves the per-user enrollment config (server URL + token). 4.0: only for
   * whoever may change that person (docs/4.0/SPEC.md 1.2, 5.3: the Admin for their
   * organisation's Managers and Staff, a Super Admin also for its Admin), never for
   * yourself: the token is a 365-day credential, and minting one for yourself would
   * outlive a sign-out key or a blocked password. Everyone else signs the agent in
   * with their password. Someone outside the caller's organisation is "not found".
   * The token carries the person's enrollVersion, so a key sign-out or a "sign out
   * everywhere" password reset retires it.
   */
  private async buildConfig(me: AuthenticatedUser, userId: string): Promise<AgentEnrollConfig> {
    const target = await this.users.findById(userId);
    try {
      this.access.assertCanEdit(me, target);
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundException('User not found.');
      throw new ForbiddenException(
        'Only the organisation admin can issue an installer or a setup code for this person.',
      );
    }
    const person = target!;

    const token = await this.tokens.signEnrollmentToken(person.id, person.enrollVersion);
    await this.audit.record({
      actorId: me.id,
      action: 'AGENT_ENROLLMENT_ISSUED',
      entity: 'USER',
      entityId: person.id,
      metadata: { enrollVersion: person.enrollVersion, self: person.id === me.id },
    });
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

/**
 * "RXVision.exe" + "Praveen V S" -> "RXVision-Praveen-V-S.exe" (letters and digits
 * only, so the Content-Disposition header stays plain ASCII). No usable name: the
 * base name unchanged.
 */
export function personalFileName(base: string, personName: string | null | undefined): string {
  const slug = (personName ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return base;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? `${base.slice(0, dot)}-${slug}${base.slice(dot)}` : `${base}-${slug}`;
}
