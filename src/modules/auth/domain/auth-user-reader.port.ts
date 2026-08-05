import { AuthenticatedUser } from '@shared/rbac/authenticated-user';

export const AUTH_USER_READER = Symbol('AUTH_USER_READER');

export interface AuthUserReader {
  loadById(id: string): Promise<AuthenticatedUser | null>;
}
