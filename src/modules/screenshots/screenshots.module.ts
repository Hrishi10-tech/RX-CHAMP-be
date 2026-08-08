import { Module } from '@nestjs/common';
import { SCREENSHOT_REPOSITORY } from './domain/screenshot.repository';
import { SCREENSHOT_ACCESS_READER } from './domain/screenshot-access.reader';
import { DAY_END_READER } from './domain/day-end.reader';
import { PrismaScreenshotRepository } from './infrastructure/prisma-screenshot.repository';
import { PrismaScreenshotAccessReader } from './infrastructure/prisma-screenshot-access.reader';
import { PrismaDayEndReader } from './infrastructure/prisma-day-end.reader';
import { S3StorageService } from './infrastructure/s3-storage.service';
import { OcrService } from './infrastructure/ocr.service';
import { UploadScreenshotUseCase } from './application/use-cases/upload-screenshot.use-case';
import { ListScreenshotsUseCase } from './application/use-cases/list-screenshots.use-case';
import { RequestCaptureUseCase } from './application/use-cases/request-capture.use-case';
import { ArchiveScreenshotsUseCase } from './application/use-cases/archive-screenshots.use-case';
import { ExportScreenshotsUseCase } from './application/use-cases/export-screenshots.use-case';
import { ScreenshotsController } from './presentation/screenshots.controller';
import { ScreenshotsGateway } from './presentation/screenshots.gateway';

@Module({
  controllers: [ScreenshotsController],
  providers: [
    { provide: SCREENSHOT_REPOSITORY, useClass: PrismaScreenshotRepository },
    { provide: SCREENSHOT_ACCESS_READER, useClass: PrismaScreenshotAccessReader },
    { provide: DAY_END_READER, useClass: PrismaDayEndReader },
    S3StorageService,
    OcrService,
    ScreenshotsGateway,
    UploadScreenshotUseCase,
    ListScreenshotsUseCase,
    RequestCaptureUseCase,
    ArchiveScreenshotsUseCase,
    ExportScreenshotsUseCase,
  ],
})
export class ScreenshotsModule {}
