export interface SocketTokenClaims {
  sub?: string;
  /**
   * `'socket'` for a ticket minted by /auth/socket-ticket; absent on a normal access
   * token. Handshakes accept both — an access-token cookie still works where the
   * browser will send it, and the Windows agent passes its access token directly.
   */
  typ?: string;
}

export interface SocketHandshakeAuth {
  token?: unknown;
}
