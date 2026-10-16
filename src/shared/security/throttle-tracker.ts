import { JwtService } from '@nestjs/jwt';

const MAX_TOKEN_LENGTH = 4096;

function bearer(header: unknown): string | null {
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
}

/**
 * Who a request counts against for rate limiting: the signed-in person when the
 * request carries a valid access token, otherwise the client address.
 *
 * Keying everything on the address put a whole office behind one NAT address
 * into one bucket: forty agents each sending a heartbeat, an activity sample
 * and a screenshot a minute would trip a per-address limit and lose data. A
 * forged or expired token never gets its own bucket; it falls back to the address.
 */
export function throttleTracker(jwt: JwtService) {
  return (req: Record<string, any>): string => {
    const raw: unknown = req?.cookies?.accessToken ?? bearer(req?.headers?.authorization);
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_TOKEN_LENGTH) {
      try {
        const claims = jwt.verify<{ sub?: string; typ?: string }>(raw);
        if (claims?.sub && claims.typ !== 'socket') return `user:${claims.sub}`;
      } catch {
        // Expired or forged: counted against the address below.
      }
    }
    return `ip:${req?.ip ?? 'unknown'}`;
  };
}
