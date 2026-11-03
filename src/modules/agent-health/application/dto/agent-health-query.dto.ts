import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';
import { IsId } from '@shared/validation/is-id';

export class AgentHealthQueryDto {
  @ApiPropertyOptional({
    description:
      'Super Admin or Super Manager: one organisation (default: the one picked with X-Org-Id, or every organisation)',
  })
  @IsOptional()
  @IsId()
  companyId?: string;

  @ApiPropertyOptional({
    description: 'One department the caller may see (4.0; replaces managerId)',
  })
  @IsOptional()
  @IsId()
  departmentId?: string;

  @ApiPropertyOptional({ description: 'Only people with something to look at', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  problemsOnly?: boolean;
}
