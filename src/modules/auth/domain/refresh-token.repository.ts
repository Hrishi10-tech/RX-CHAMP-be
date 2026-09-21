export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

export interface RefreshTokenMeta {
  userAgent: string | null;
  ip: string | null;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

export interface RotatedRefreshToken {
  userId: string;
  token: string;
  expiresAt: Date;
}

export interface RefreshTokenRepository {
  issue(userId: string, meta: RefreshTokenMeta): Promise<IssuedRefreshToken>;

  rotate(rawToken: string, meta: RefreshTokenMeta): Promise<RotatedRefreshToken | null>;

  revoke(rawToken: string): Promise<void>;
  /**
   * Deletes tokens that died before the cutoff — expired, or revoked. Neither can
   * authenticate anyone, so the rows are weight without meaning. Answers how many.
   */
  purgeDead(cutoff: Date): Promise<number>;
}
