export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');
export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: string;
}

/** Marks a token as usable for a socket handshake only, never as an API credential. */
export const SOCKET_TOKEN_TYPE = 'socket';

/**
 * Ticket lifetime. Long enough that a slow page load or a queued reconnect doesn't
 * arrive with an expired ticket, short enough that one leaking is worth little.
 *
 * Note the gateways check the token only at handshake — an established socket stays
 * authenticated for its lifetime — so this bounds how long a ticket can be *used to
 * connect*, not how long a connection lasts. Clients must fetch a fresh one before
 * reconnecting, since socket.io replays the original auth payload.
 */
export const SOCKET_TICKET_TTL_SEC = 300;

export interface TokenService {
  signAccessToken(payload: AccessTokenPayload): Promise<string>;

  /**
   * Short-lived token a browser can hand to socket.io in the handshake.
   *
   * The gateways authenticate off the `accessToken` cookie, which browsers refuse to
   * send when the socket lives on a different site from the page — so a cross-origin
   * dashboard could never open one. This is the way round that: the page fetches a
   * ticket over same-origin HTTP (where the cookie does travel) and passes it in
   * `auth.token`.
   *
   * Carries `typ: 'socket'` so it cannot double as an API credential. It is readable
   * by JavaScript, unlike the httpOnly cookie, so anything that got hold of one must
   * not be able to call the REST API with it — the HTTP strategy rejects this type.
   */
  signSocketTicket(payload: AccessTokenPayload): Promise<string>;

  /** Long-lived, per-user token baked into an agent download for password-less enrollment. */
  signEnrollmentToken(userId: string): Promise<string>;

  /** Verifies an enrollment token and returns its userId, or throws if invalid/expired. */
  verifyEnrollmentToken(token: string): Promise<string>;
}
