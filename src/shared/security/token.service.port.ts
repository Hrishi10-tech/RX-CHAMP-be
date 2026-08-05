
export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');
export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
}

export interface TokenService {
  signAccessToken(payload: AccessTokenPayload): Promise<string>;

  /** Long-lived, per-user token baked into an agent download for password-less enrollment. */
  signEnrollmentToken(userId: string): Promise<string>;

  /** Verifies an enrollment token and returns its userId, or throws if invalid/expired. */
  verifyEnrollmentToken(token: string): Promise<string>;
}
