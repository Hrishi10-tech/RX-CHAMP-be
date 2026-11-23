import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

export type Gender = 'MALE' | 'FEMALE';
export type AvatarLibrary = 'male' | 'female';

/** The WebP sizes generated at build time. Keep in step with scripts/build-avatars.mjs. */
export const AVATAR_SIZES = [48, 96, 144, 192] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

export interface AvatarEntry {
  id: string;
  gender: AvatarLibrary;
  set: number;
  /** The PNG master, relative to the library folder. */
  file: string;
}

const LIBRARY_OF: Record<Gender, AvatarLibrary> = { MALE: 'male', FEMALE: 'female' };

/** Both dist/shared/avatars and src/shared/avatars sit three levels under the project. */
export const AVATAR_LIBRARY_DIR = resolve(__dirname, '..', '..', '..', 'assets', 'avatars');

/** The library a gender sees; null when the person has none yet. */
export function libraryOf(gender: Gender | null | undefined): AvatarLibrary | null {
  return gender ? (LIBRARY_OF[gender] ?? null) : null;
}

function fail(message: string): never {
  throw new Error(`Invalid avatar manifest: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(raw: unknown, index: number): AvatarEntry {
  if (!isRecord(raw)) fail(`entry ${index} is not an object`);
  const { id, gender, set, file } = raw;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    fail(`entry ${index} has a bad id`);
  }
  if (gender !== 'male' && gender !== 'female') fail(`${id} has a bad gender`);
  if (typeof set !== 'number' || !Number.isInteger(set) || set < 1) fail(`${id} has a bad set`);
  if (typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..')) {
    fail(`${id} has a bad file`);
  }
  return { id, gender, set, file };
}

/**
 * The preset avatar library. Everything about an avatar comes from manifest.json, so
 * higher-resolution originals with the same names replace the files with no code change.
 * The manifest is read once at boot and a bad one stops the boot, like a bad environment.
 */
export class AvatarCatalog {
  readonly version: number;
  readonly defaults: Readonly<Record<AvatarLibrary, string>>;
  readonly entries: readonly AvatarEntry[];
  private readonly byId = new Map<string, AvatarEntry>();
  private hashes: Map<string, string> | null = null;

  constructor(
    manifest: unknown,
    private readonly dir: string,
  ) {
    if (!isRecord(manifest)) fail('not an object');
    const { version, default: defaults, avatars } = manifest;
    if (typeof version !== 'number') fail('version is missing');
    if (!Array.isArray(avatars) || avatars.length === 0) fail('avatars is empty');
    this.version = version;
    this.entries = avatars.map(parseEntry);
    for (const entry of this.entries) {
      if (this.byId.has(entry.id)) fail(`${entry.id} is listed twice`);
      this.byId.set(entry.id, entry);
    }
    if (!isRecord(defaults)) fail('default is missing');
    this.defaults = {
      male: this.parseDefault(defaults.male, 'male'),
      female: this.parseDefault(defaults.female, 'female'),
    };
  }

  static load(dir: string = AVATAR_LIBRARY_DIR): AvatarCatalog {
    const catalog = new AvatarCatalog(
      JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')),
      dir,
    );
    for (const entry of catalog.entries) {
      if (!existsSync(join(dir, entry.file))) fail(`${entry.file} is missing`);
    }
    return catalog;
  }

  private parseDefault(id: unknown, library: AvatarLibrary): string {
    const entry = typeof id === 'string' ? this.byId.get(id) : undefined;
    if (entry?.gender !== library) fail(`the ${library} default is not in the ${library} library`);
    return entry.id;
  }

  find(id: string): AvatarEntry | undefined {
    return this.byId.get(id);
  }

  /** What a person shows: their choice while it fits their library, else the default. */
  effective(gender: Gender | null | undefined, chosen: string | null | undefined): string | null {
    const library = libraryOf(gender);
    if (!library) return null;
    const entry = chosen ? this.byId.get(chosen) : undefined;
    return entry?.gender === library ? entry.id : this.defaults[library];
  }

  /** The generated WebP for a size and an ID; null for anything the library does not have. */
  webpPath(size: number, id: string): string | null {
    if (!(AVATAR_SIZES as readonly number[]).includes(size) || !this.byId.has(id)) return null;
    const path = join(this.dir, 'webp', String(size), `${id}.webp`);
    return existsSync(path) ? path : null;
  }

  /** A short hash of a generated file's content; null when it was not generated. */
  contentHash(size: AvatarSize, id: string): string | null {
    return this.contentHashes().get(`${size}/${id}`) ?? null;
  }

  /** How many generated files are missing, for the boot log. */
  missingFiles(): number {
    return this.entries.length * AVATAR_SIZES.length - this.contentHashes().size;
  }

  private contentHashes(): Map<string, string> {
    if (this.hashes) return this.hashes;
    const hashes = new Map<string, string>();
    for (const entry of this.entries) {
      for (const size of AVATAR_SIZES) {
        const path = this.webpPath(size, entry.id);
        if (!path) continue;
        const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12);
        hashes.set(`${size}/${entry.id}`, hash);
      }
    }
    this.hashes = hashes;
    return hashes;
  }
}

let shared: AvatarCatalog | null = null;

/** The library, read once. Mappers and readers without injection reach it through here. */
export function avatarCatalog(): AvatarCatalog {
  shared ??= AvatarCatalog.load();
  return shared;
}
