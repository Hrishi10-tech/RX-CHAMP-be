import { Body, Controller, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import {
  ArchiveScreenshotsDto,
  CaptureRequestDto,
  CompleteUploadDto,
  ExportScreenshotsQueryDto,
  ListScreenshotsQueryDto,
  RequestUploadUrlDto,
} from '../application/dto';
import { UploadScreenshotUseCase } from '../application/use-cases/upload-screenshot.use-case';
import { ListScreenshotsUseCase } from '../application/use-cases/list-screenshots.use-case';
import { RequestCaptureUseCase } from '../application/use-cases/request-capture.use-case';
import { ArchiveScreenshotsUseCase } from '../application/use-cases/archive-screenshots.use-case';
import { ExportScreenshotsUseCase } from '../application/use-cases/export-screenshots.use-case';

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

  @Post('upload-url')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Agent asks for a presigned S3 POST for one screenshot. Upload `fields` plus the ' +
      'file (last, as "file") to `url`, then call POST /screenshots/complete with `key`.',
  })
  async uploadUrl(@CurrentUser() me: AuthenticatedUser, @Body() body: RequestUploadUrlDto) {
    return envelope(
      await this.uploadScreenshot.requestUpload(me.id, {
        contentType: body.contentType ?? 'image/jpeg',
        kind: body.kind,
        takenAt: body.takenAt ? new Date(body.takenAt) : undefined,
      }),
    );
  }

  @Post('complete')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Agent says a presigned upload is done; the shot is checked and recorded',
  })
  async complete(@CurrentUser() me: AuthenticatedUser, @Body() body: CompleteUploadDto) {
    return envelope(
      await this.uploadScreenshot.completeUpload(me.id, {
        key: body.key,
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
