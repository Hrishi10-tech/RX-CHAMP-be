import { Module } from '@nestjs/common';
import { AuthModule } from '@modules/auth/auth.module';
import { UsersModule } from '@modules/users/users.module';
import { SignOutKeysService } from './application/signout-keys.service';
import {
  AgentSignOutController,
  SignOutKeysController,
} from './presentation/signout-keys.controller';

/** Sign-out keys and the agent's key-gated sign-out and quit (docs/4.0/SPEC.md 2.8). */
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [SignOutKeysController, AgentSignOutController],
  providers: [SignOutKeysService],
})
export class SignOutKeysModule {}
