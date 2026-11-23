#!/usr/bin/env node
/**
 * Generates the WebP sizes the API serves from the PNG masters in assets/avatars,
 * into assets/avatars/webp/<size>/<id>.webp (gitignored). Run by `npm run build`.
 *
 * Only the manifest names the files, so higher-resolution originals with the same
 * names can replace the masters and the next build picks them up. Every master is encoded
 * on every build, because a replaced one can carry an older date than its WebP (unzip,
 * rsync -a, cp -p). A WebP is only written when its bytes change, so a running API never
 * reads one half written on a build that changes nothing.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const LIBRARY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'avatars');
const OUT = join(LIBRARY, 'webp');
/** Keep in step with AVATAR_SIZES in src/shared/avatars/avatar-catalog.ts. */
const SIZES = [48, 96, 144, 192];
const PARALLEL = 4;

async function contentOf(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function generate(entry, size) {
  const master = await contentOf(join(LIBRARY, entry.file));
  if (master === null)
    throw new Error(`${entry.id}: ${entry.file} is listed in the manifest but missing`);
  const webp = await sharp(master)
    .resize(size, size, { fit: 'cover' })
    .webp({ quality: 88, alphaQuality: 100, effort: 5 })
    .toBuffer();
  const target = join(OUT, String(size), `${entry.id}.webp`);
  if ((await contentOf(target))?.equals(webp)) return false;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, webp);
  return true;
}

const manifest = JSON.parse(await readFile(join(LIBRARY, 'manifest.json'), 'utf8'));
const jobs = manifest.avatars.flatMap((entry) => SIZES.map((size) => [entry, size]));

let next = 0;
let built = 0;
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < jobs.length) {
      const [entry, size] = jobs[next++];
      if (await generate(entry, size)) built += 1;
    }
  }),
);
console.log(
  `avatars: ${manifest.avatars.length} in the manifest, ${jobs.length} WebP files, ${built} built`,
);
