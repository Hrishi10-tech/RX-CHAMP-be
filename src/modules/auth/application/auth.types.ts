import { PublicUser } from '@modules/users/application/user.types';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends AuthTokens {
  user: PublicUser;
}
