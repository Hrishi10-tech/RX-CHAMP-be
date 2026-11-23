import { createHash, randomBytes } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import {
  BIOMETRIC_REPOSITORY,
  BiometricRepository,
  KeyRecord,
} from '../domain/biometric.repository';

const KEY_PREFIX = 'rxb_';
/** A key's last use is written at most this often (every request would be a write). */
const TOUCH_EVERY_MS = 60_000;

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export interface KeyView {
  id: string;
  name: string;
  /** The first characters, to recognise it ("rxb_3f9a2c"). */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  active: boolean;
}

function keyView(k: KeyRecord): KeyView {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: k.lastUsedIp,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    active: !k.revokedAt,
  };
}

/**
 * Integration keys for POST /biometric/punches (3.5). A key is shown once, when
 * made; only its SHA-256 is kept. Revoking one stops it at once. 4.0: a key belongs
 * to one organisation, and its punches match that organisation's people only.
 */
@Injectable()
export class BiometricKeysService {
  private readonly logger = new Logger(BiometricKeysService.name);
  private readonly touched = new Map<string, number>();

  constructor(@Inject(BIOMETRIC_REPOSITORY) private readonly repo: BiometricRepository) {}

  async create(
    companyId: string,
    name: unknown,
    byId: string,
  ): Promise<{ key: string; view: KeyView }> {
    const label = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (label.length < 2 || label.length > 80) {
      throw new ValidationError('Name the key, 2 to 80 characters (where it is used).').withDetails(
        {
          field: 'name',
        },
      );
    }
    const key = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const saved = await this.repo.createKey({
      companyId,
      name: label,
      prefix: key.slice(0, 10),
      hash: hashKey(key),
      createdById: byId,
    });
    this.logger.log(`biometric key ${saved.id} (${label}) of ${companyId} made by ${byId}`);
    return { key, view: keyView(saved) };
  }

  async list(companyId: string): Promise<KeyView[]> {
    return (await this.repo.listKeys(companyId)).map(keyView);
  }

  async revoke(companyId: string, id: string, byId: string, now: Date): Promise<{ revoked: true }> {
    if (!(await this.repo.revokeKey(companyId, id, byId, now))) {
      throw new NotFoundError('Unknown key, or already revoked');
    }
    this.logger.log(`biometric key ${id} revoked by ${byId}`);
    return { revoked: true };
  }

  /** The key behind the header, or 401. */
  async verify(header: string | undefined, ip: string | null, now: Date): Promise<KeyRecord> {
    const key = (header ?? '').trim();
    if (!key.startsWith(KEY_PREFIX) || key.length < 20 || key.length > 200) {
      throw new UnauthorizedError(
        'Send a biometric integration key in the X-Biometric-Key header.',
      );
    }
    const found = await this.repo.findKeyByHash(hashKey(key));
    if (!found || found.revokedAt) {
      throw new UnauthorizedError('This biometric integration key is unknown or revoked.');
    }
    const last = this.touched.get(found.id) ?? 0;
    if (now.getTime() - last > TOUCH_EVERY_MS) {
      this.touched.set(found.id, now.getTime());
      await this.repo.touchKey(found.id, now, ip).catch(() => undefined);
    }
    return found;
  }
}
