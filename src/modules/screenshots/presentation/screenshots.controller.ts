import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import {
  ArchiveScreenshotsDto,
  CaptureRequestDto,
  ExportScreenshotsQueryDto,
  ListScreenshotsQueryDto,
  UploadScreenshotDto,
} from '../application/dto';
import { UploadScreenshotUseCase } from '../application/use-cases/upload-screenshot.use-case';
import { ListScreenshotsUseCase } from '../application/use-cases/list-screenshots.use-case';
import { RequestCaptureUseCase } from '../application/use-cases/request-capture.use-case';
import { ArchiveScreenshotsUseCase } from '../application/use-cases/archive-screenshots.use-case';
import { ExportScreenshotsUseCase } from '../application/use-cases/export-screenshots.use-case';

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024; // 8 MB

@ApiTags('screenshots')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('screenshots')
export class ScreenshotsController {
  constructor(
    private readonly uploadScreenshot: UploadScreenshotUseCase,
    private readonly listScreenshots: ListScreenshotsUseCase,
    private readonly requestCapture: RequestCaptureUseCase,
    private readonly archiveScreenshots: ArchiveScreenshotsUseCase,
    private readonly exportScreenshots: ExportScreenshotsUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Agent uploads a captured screenshot (field "file")' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SCREENSHOT_BYTES } }))
  async upload(
    @CurrentUser() me: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadScreenshotDto,
  ) {
    if (!file) throw new BadRequestException('Missing "file"');
    return envelope(
      await this.uploadScreenshot.execute(me.id, {
        buffer: file.buffer,
        contentType: file.mimetype,
        kind: body.kind,
        takenAt: body.takenAt ? new Date(body.takenAt) : undefined,
      }),
    );
  }

  @Get()
  @ApiOperation({ summary: "List a user's screenshots (manager/admin/self) with presigned URLs" })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() query: ListScreenshotsQueryDto) {
    return envelope(await this.listScreenshots.execute(me, query));
  }

  @Post('capture')
  @HttpCode(202)
  @ApiOperation({ summary: "Ask a user's agent to capture a screenshot now" })
  async capture(@CurrentUser() me: AuthenticatedUser, @Body() body: CaptureRequestDto) {
    return envelope(await this.requestCapture.execute(me, body.userId));
  }

  @Post('archive')
  @ApiOperation({ summary: 'Archive screenshots (hidden from the default list)' })
  async archive(@CurrentUser() me: AuthenticatedUser, @Body() body: ArchiveScreenshotsDto) {
    return envelope(await this.archiveScreenshots.execute(me, body));
  }

  @Get('export')
  @ApiOperation({ summary: 'Export a CSV manifest (id, takenAt, kind, presigned url)' })
  async export(
    @CurrentUser() me: AuthenticatedUser,
    @Query() query: ExportScreenshotsQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.exportScreenshots.execute(me, query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="screenshots.csv"');
    res.send(csv);
  }
}
