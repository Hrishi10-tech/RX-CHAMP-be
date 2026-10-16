import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsId } from '@shared/validation/is-id';
import { IsDateKey } from '@shared/validation/date-key';
import { APPROVAL_CATEGORIES, ApprovalCategory } from '../../domain/approval-copy';

/** DECIDED = approved or rejected (the portal's "All decisions" tab). */
export const APPROVAL_STATUS_QUERY = ['PENDING', 'APPROVED', 'REJECTED', 'DECIDED', 'ALL'] as const;
export const APPROVAL_TYPES_QUERY = ['BREAK', 'MEETING'] as const;
export const APPROVAL_PATH_TYPES = ['break', 'meeting'] as const;
export type ApprovalPathType = (typeof APPROVAL_PATH_TYPES)[number];

/** GET /approvals */
export class ApprovalsListQueryDto {
  @ApiPropertyOptional({ enum: APPROVAL_STATUS_QUERY, default: 'PENDING' })
  @IsOptional()
  @IsIn(APPROVAL_STATUS_QUERY)
  status?: (typeof APPROVAL_STATUS_QUERY)[number] = 'PENDING';

  @ApiPropertyOptional({
    enum: ['mine', 'all'],
    default: 'mine',
    description: 'all: Super Admin only',
  })
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: 'mine' | 'all' = 'mine';

  @ApiPropertyOptional({ enum: APPROVAL_TYPES_QUERY })
  @IsOptional()
  @IsIn(APPROVAL_TYPES_QUERY)
  type?: 'BREAK' | 'MEETING';

  @ApiPropertyOptional({ enum: APPROVAL_CATEGORIES })
  @IsOptional()
  @IsIn(APPROVAL_CATEGORIES)
  category?: ApprovalCategory;

  @ApiPropertyOptional({ description: 'Only pending items past their due time' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ example: '2026-10-14' })
  @IsOptional()
  @IsDateKey()
  date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsId()
  userId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}

/** GET /approvals/me */
export class MyApprovalsQueryDto {
  @ApiPropertyOptional({ default: 7, minimum: 1, maximum: 31 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  days?: number = 7;
}

/** POST /approvals/:type/:id/approve */
export class ApproveItemDto {
  @ApiPropertyOptional({ description: 'Optional note the person sees' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST /approvals/:type/:id/reject (the note is checked by the service: 400 NOTE_REQUIRED) */
export class RejectItemDto {
  @ApiProperty({ description: 'Why it was rejected (3+ characters); the person sees it' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApprovalRefDto {
  @ApiProperty({ enum: APPROVAL_PATH_TYPES })
  @IsIn(APPROVAL_PATH_TYPES)
  type!: ApprovalPathType;

  @ApiProperty()
  @IsId()
  id!: string;
}

/** POST /approvals/bulk-approve */
export class BulkApproveItemsDto {
  @ApiProperty({ type: [ApprovalRefDto], maxItems: 200 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ApprovalRefDto)
  items!: ApprovalRefDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
