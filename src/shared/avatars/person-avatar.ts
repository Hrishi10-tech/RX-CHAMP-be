import { avatarCatalog, Gender } from './avatar-catalog';

/** The columns a person's avatar is worked out from; spread into a Prisma `select`. */
export const AVATAR_COLUMNS = { gender: true, avatarId: true } as const;

export interface AvatarColumns {
  gender?: Gender | null;
  avatarId?: string | null;
}

/**
 * The avatar a person shows: their chosen preset, else the default for their gender,
 * else null (no gender yet: clients show initials). This, never the raw column, is the
 * `avatarId` in every API response.
 */
export function effectiveAvatarId(person: AvatarColumns): string | null {
  return avatarCatalog().effective(person.gender, person.avatarId);
}

/** A selected row with the raw columns swapped for the effective avatar, so gender stays here. */
export function withEffectiveAvatar<T extends AvatarColumns>(
  row: T,
): Omit<T, 'gender' | 'avatarId'> & { avatarId: string | null } {
  const { gender, avatarId, ...rest } = row;
  return { ...rest, avatarId: effectiveAvatarId({ gender, avatarId }) };
}
