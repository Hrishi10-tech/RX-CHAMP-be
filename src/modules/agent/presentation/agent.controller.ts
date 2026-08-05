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
import { createReadStream, existsSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import archiver from 'archiver';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
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
import { AgentEnrollConfig, AgentVersionInfo } from '../application/agent.types';

/**
 * Serves the Windows agent. With `?userId=`, the caller (that user's manager, or
 * an admin) gets a copy with a per-user enrollment token + server URL baked into
 * the file, so the employee runs it and it enrolls itself — no login. Without
 * `userId`, the plain generic build is served (falls back to the login screen).
 */
@ApiTags('agent')
@ApiBearerAuth()
@Controller('agent')
export class AgentController {
  constructor(
    private readonly config: ConfigService,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  private binaryPath(): string {
    const p = this.config.get<string>('agent.binaryPath') ?? '';
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }

  @Get('version')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Agent version + whether the binary is available to download' })
  version(): EnvelopePayload<AgentVersionInfo> {
    const path = this.binaryPath();
    const available = existsSync(path);
    return envelope<AgentVersionInfo>({
      version: this.config.get<string>('agent.version') ?? '',
      fileName: this.config.get<string>('agent.fileName') ?? '',
      available,
      sizeBytes: available ? statSync(path).size : 0,
    });
  }

  @Get('download')
  @UseGuards(JwtAuthGuard)
  @ApiQuery({
    name: 'userId',
    required: false,
    description: "Bake this user's enrollment into the download.",
  })
  @ApiOperation({ summary: 'Download the Windows agent (per-user when userId is given)' })
  async download(
    @CurrentUser() me: AuthenticatedUser,
    @Res() res: Response,
    @Query('userId') userId?: string,
  ): Promise<void> {
    const path = this.binaryPath();
    if (!existsSync(path)) {
      throw new NotFoundException('Agent binary is not available on the server yet.');
    }

    const config = userId ? await this.buildConfig(me, userId) : null;

    // A directory means the modern WinUI agent: ship the whole self-contained
    // folder as a ZIP (its single-file exe isn't viable). A file means the legacy
    // single-exe agent: stream it and append the per-user config trailer.
    if (statSync(path).isDirectory()) {
      await this.downloadZip(res, path, config);
    } else {
      this.downloadExe(res, path, config);
    }
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

  /** Streams a single-exe agent, appending the per-user config trailer. */
  private downloadExe(res: Response, path: string, config: AgentEnrollConfig | null): void {
    const trailer = config ? this.buildTrailer(config) : Buffer.alloc(0);

    const fileName = this.config.get<string>('agent.fileName') ?? DEFAULT_EXE_FILE_NAME;
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': (statSync(path).size + trailer.length).toString(),
    });

    const stream = createReadStream(path);
    stream.on('error', () => res.destroy());
    stream.on('end', () => {
      if (trailer.length) res.write(trailer);
      res.end();
    });
    stream.pipe(res, { end: false });
  }

  /**
   * Resolves the per-user enrollment config (server URL + one-time token).
   * Only the user's manager (or an admin) may request their enrollment.
   */
  private async buildConfig(me: AuthenticatedUser, userId: string): Promise<AgentEnrollConfig> {
    const target = await this.users.findById(userId);
    if (!target) throw new NotFoundException('User not found.');

    const privileged = me.role === Role.ADMIN || me.role === Role.SUPER_ADMIN;
    if (!privileged && target.managerId !== me.id) {
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
