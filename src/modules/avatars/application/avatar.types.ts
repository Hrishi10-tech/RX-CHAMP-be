import { AvatarLibrary } from '@shared/avatars/avatar-catalog';

export interface AvatarManifestItem {
  id: string;
  gender: AvatarLibrary;
  set: number;
  /** Size to URL; each URL carries a content hash, so it can be cached for ever. */
  files: Record<string, string>;
}

export interface AvatarManifestView {
  version: number;
  defaults: Record<AvatarLibrary, string>;
  avatars: AvatarManifestItem[];
}

export interface MyAvatarView {
  /** What the person shows: the choice or the default; null while they have no gender. */
  avatarId: string | null;
  chosenAvatarId: string | null;
  defaultAvatarId: string | null;
  library: AvatarLibrary | null;
}

export interface UserAvatarResetView {
  userId: string;
  avatarId: string | null;
}
