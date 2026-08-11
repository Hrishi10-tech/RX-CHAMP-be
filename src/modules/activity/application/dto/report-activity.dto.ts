import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/** One foreground-activity sample the agent posts (≈ once per minute). */
export class ReportActivityDto {
  @ApiPropertyOptional({
    description: 'Sample time (ISO-8601). Defaults to the server clock when omitted.',
    example: '2026-07-16T09:15:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  at?: string;

  @ApiPropertyOptional({
    description:
      'When the user logged into their PC (ISO-8601). The agent reports it each ' +
      'sample; the server keeps the earliest per day as the login time.',
    example: '2026-07-16T09:02:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  loginAt?: string;

  @ApiPropertyOptional({
    description: 'True when the machine has been idle past the agent threshold.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  idle?: boolean;

  @ApiPropertyOptional({
    description:
      'True when the workstation is locked (Win+L / logged off / RDP disconnected). ' +
      'Implies `idle`, and tells the server the inactivity started at this instant ' +
      'rather than one idle-threshold ago, so preceding work is left alone.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  locked?: boolean;

  @ApiPropertyOptional({ description: 'Friendly foreground app name.', example: 'Google Chrome' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  app?: string;

  @ApiPropertyOptional({
    description: 'Foreground window title.',
    example: 'Pull requests · GitHub',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @ApiPropertyOptional({
    description: 'Website host when the foreground app is a browser (host only).',
    example: 'github.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  url?: string;
}
