import { ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';

/**
 * PATCH /settings: any subset of the settings table. Values are typed `unknown`
 * on purpose: the range and type rules live in applySettingsPatch, which answers
 * 400 VALIDATION_ERROR with the offending key in `details.field` (the generic
 * validation pipe cannot say which field). Unknown keys are dropped.
 */
export class PatchSettingsDto {
  @ApiPropertyOptional({ type: Number, minimum: 12, maximum: 168, example: 48 })
  @Allow()
  approvalSlaHours?: unknown;

  @ApiPropertyOptional({ type: Boolean, example: true })
  @Allow()
  blockManagerEndDayWhenOverdue?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, example: 80 })
  @Allow()
  fullDayPct?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 99, example: 40 })
  @Allow()
  halfDayPct?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 120, example: 10 })
  @Allow()
  lateStartGraceMin?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 59, example: 20 })
  @Allow()
  quietHourActiveMin?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, example: 4 })
  @Allow()
  quietHoursFlag?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 30, maximum: 720, example: 240 })
  @Allow()
  autoCloseAfterShiftEndMin?: unknown;
}
