import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ORG_NAME } from '../../domain/organisation.rules';

export class OrganisationNameDto {
  @ApiProperty({ example: 'Xelements Health', minLength: ORG_NAME.min, maxLength: ORG_NAME.max })
  @IsString({ message: 'Name the organisation.' })
  @MaxLength(200)
  name!: string;
}

export class CreateOrgAdminDto {
  @ApiProperty({ example: 'Asha' })
  @IsString()
  @MinLength(1, { message: 'Enter a first name.' })
  @MaxLength(60)
  firstName!: string;

  @ApiProperty({ example: 'Raman' })
  @IsString()
  @MinLength(1, { message: 'Enter a last name.' })
  @MaxLength(60)
  lastName!: string;

  @ApiProperty({ example: 'asha@example.com' })
  @IsEmail({}, { message: 'Enter a valid email address.' })
  @MaxLength(254)
  email!: string;

  @ApiProperty({ minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8, { message: 'Use at least 8 characters for the password.' })
  @MaxLength(128)
  password!: string;
}
