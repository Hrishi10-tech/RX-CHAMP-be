export interface SocketTokenClaims {
  sub?: string;
  /**
   * `'socket'` for a ticket minted by /auth/socket-ticket; absent on a normal access
   * token. Handshakes accept both — an access-token cookie still works where the
   * browser will send it, and the Windows agent passes its access token directly.
   */
  typ?: string;
  /** The account's auth epoch when the token or ticket was minted; absent counts as 0. */
  ep?: unknown;
}

/** Who a verified handshake credential is for, and the epoch it was minted under. */
export interface SocketIdentity {
  userId: string;
  epoch: number;
}

export interface SocketHandshakeAuth {
  token?: unknown;
}
