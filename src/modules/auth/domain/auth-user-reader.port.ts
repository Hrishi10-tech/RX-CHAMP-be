import { AuthenticatedUser } from '@shared/rbac/authenticated-user';

export const AUTH_USER_READER = Symbol('AUTH_USER_READER');

export interface AuthUserReader {
  /**
   * The signed-in person with their organisation, departments and grants.
   * `orgHeader` is the X-Org-Id header: a Super Admin acts in that organisation.
   */
  loadById(id: string, orgHeader?: string | null): Promise<AuthenticatedUser | null>;
}
