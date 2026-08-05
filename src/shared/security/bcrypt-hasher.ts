
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PasswordHasher } from './password-hasher.port';

@Injectable()
export class BcryptHasher implements PasswordHasher {
  private readonly saltRounds: number;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.saltRounds = config.get<{ bcryptSaltRounds: number }>('security')!.bcryptSaltRounds;
  }

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.saltRounds);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
