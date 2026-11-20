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

  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    maximum: 120,
    example: 10,
    description: 'Minutes after the shift start a day may begin without a reason',
  })
  @Allow()
  lateStartGraceMin?: unknown;

  @ApiPropertyOptional({ type: Boolean, example: true })
  @Allow()
  requireLateStartReason?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 59, example: 20 })
  @Allow()
  quietHourActiveMin?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, example: 4 })
  @Allow()
  quietHoursFlag?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 30, maximum: 720, example: 240 })
  @Allow()
  autoCloseAfterShiftEndMin?: unknown;

  @ApiPropertyOptional({ type: Number, minimum: 0, maximum: 60, example: 10 })
  @Allow()
  breakBufferMin?: unknown;

  @ApiPropertyOptional({
    type: Boolean,
    example: true,
    description: '3.3: the Super Manager may adjust focus time by hand (meant for a rollout)',
  })
  @Allow()
  focusAdjustmentsEnabled?: unknown;

  @ApiPropertyOptional({
    type: Number,
    minimum: 10,
    maximum: 240,
    example: 30,
    description:
      '3.2 Forgotten End Day: after the shift ends, a day with no keyboard or mouse input for this long is ended at that last input',
  })
  @Allow()
  forgottenEndDayIdleMin?: unknown;
}
