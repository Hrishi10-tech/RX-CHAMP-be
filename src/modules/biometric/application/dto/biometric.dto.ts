import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  Allow,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsId } from '@shared/validation/is-id';
import { IsDateKey } from '@shared/validation/date-key';

const toBool = ({ value }: { value: unknown }) =>
  value === true || value === 'true' || value === '1'
    ? true
    : value === false || value === 'false' || value === '0'
      ? false
      : value;

/** Punches are checked one by one in the domain (punch.ts): a bad one is listed, not fatal. */
export class PushPunchesDto {
  @ApiProperty({
    description:
      'Up to 500 punches: { code, time, direction?, deviceId?, externalId? }. time: ISO 8601 with an offset, ' +
      'a local "YYYY-MM-DD HH:MM:SS" in the business time zone, or epoch seconds or milliseconds. direction: ' +
      'IN, OUT, or left out when the device does not say.',
    example: [
      {
        code: 'E1042',
        time: '2026-11-04T09:02:11+05:30',
        direction: 'IN',
        deviceId: 'GATE-1',
        externalId: '88123',
      },
    ],
  })
  @Allow()
  punches!: unknown;
}

export class AttendancePeopleQueryDto {
  @ApiPropertyOptional({ description: 'Name, email or biometric ID contains' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional({ enum: ['AGENT', 'BIOMETRIC'] })
  @IsOptional()
  @IsIn(['AGENT', 'BIOMETRIC'])
  source?: 'AGENT' | 'BIOMETRIC';
}

export class SetAttendanceDto {
  @ApiProperty({
    description:
      'Up to 500: { userId, attendanceSource?: AGENT | BIOMETRIC, biometricCode?: string | null }',
    example: [
      {
        userId: '00000000-0000-0000-0000-000000000000',
        attendanceSource: 'BIOMETRIC',
        biometricCode: 'E1042',
      },
    ],
  })
  @Allow()
  items!: unknown;
}

export class PunchesQueryDto {
  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @IsDateKey()
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @IsDateKey()
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  userId?: string;

  @ApiPropertyOptional({ description: 'A biometric ID as the device sends it' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Only punches with a code nobody has' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  unmatched?: boolean;

  @ApiPropertyOptional({ description: 'Voided punches too' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeVoided?: boolean;

  @ApiPropertyOptional({ default: 300, maximum: 2000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number;
}

export class ManualPunchDto {
  @ApiProperty()
  @IsId()
  userId!: string;

  @ApiProperty({
    example: '2026-11-04 18:05',
    description: 'Business time, or ISO 8601 with an offset',
  })
  @Allow()
  time!: unknown;

  @ApiPropertyOptional({ enum: ['IN', 'OUT'] })
  @Allow()
  direction?: unknown;

  @ApiProperty({
    example: 'Forgot to punch out; confirmed by the manager',
    description: '3 to 300 characters',
  })
  @Allow()
  note!: unknown;
}

export class VoidPunchDto {
  @ApiProperty({ example: 'Punched twice by mistake', description: '3 to 300 characters' })
  @Allow()
  reason!: unknown;
}

export class ImportCsvDto {
  @ApiProperty({
    description:
      'CSV text with a header row: code,time and optionally direction,deviceId,externalId (up to 2,000 rows ' +
      'per call; send a longer file in parts)',
  })
  @Allow()
  csv!: unknown;
}

export class CreateKeyDto {
  @ApiProperty({ example: 'eSSL connector, Chennai office' })
  @Allow()
  name!: unknown;
}

export class PatchBiometricSettingsDto {
  @ApiPropertyOptional({ enum: ['SPAN', 'PAIRS'] }) @Allow() gapRule?: unknown;
  @ApiPropertyOptional({ enum: ['LAST_PUNCH', 'SHIFT_END'] }) @Allow() missingCheckout?: unknown;
  @ApiPropertyOptional({ example: 60 }) @Allow() duplicateWindowSec?: unknown;
  @ApiPropertyOptional({ type: [String] }) @Allow() pushInWords?: unknown;
  @ApiPropertyOptional({ type: [String] }) @Allow() pushOutWords?: unknown;
  @ApiPropertyOptional({ description: 'The pull adapter (partial changes allowed)' })
  @Allow()
  pull?: unknown;
  @ApiPropertyOptional({ description: 'The pull API token (write only; null clears it)' })
  @Allow()
  secret?: unknown;
  @ApiPropertyOptional({ description: 'The pull sign-in password (write only; null clears it)' })
  @Allow()
  password?: unknown;
  @ApiPropertyOptional({
    description:
      'Integration on (3.6): off pauses payroll for biometric staff; on calculates it from today. ' +
      'Earlier days stay as they were',
  })
  @Allow()
  integrationOn?: unknown;
}
