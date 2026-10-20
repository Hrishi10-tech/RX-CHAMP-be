import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';

/** audit_logs writer, available to every module. */
@Global()
@Module({
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditModule {}
