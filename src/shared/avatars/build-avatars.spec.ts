import { execFileSync } from 'child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const BE = resolve(__dirname, '../../..');
const LONG_AGO = new Date('2026-01-01T00:00:00Z');

/** scripts/build-avatars.mjs on a copy of one avatar, so it never touches the real library. */
function aLibrary() {
  const root = mkdtempSync(join(tmpdir(), 'rxv-build-avatars-'));
  const library = join(root, 'assets', 'avatars');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(library, 'male'), { recursive: true });
  copyFileSync(join(BE, 'scripts/build-avatars.mjs'), join(root, 'scripts/build-avatars.mjs'));
  // A junction on Windows (no privilege needed); the type is ignored elsewhere.
  symlinkSync(join(BE, 'node_modules'), join(root, 'node_modules'), 'junction');
  writeFileSync(
    join(library, 'manifest.json'),
    JSON.stringify({ avatars: [{ id: 'M01', gender: 'male', set: 1, file: 'male/M01.png' }] }),
  );
  const master = join(library, 'male/M01.png');
  copyFileSync(join(BE, 'assets/avatars/male/M01.png'), master);
  return {
    root,
    master,
    webp: join(library, 'webp/96/M01.webp'),
    build: () =>
      execFileSync(process.execPath, ['scripts/build-avatars.mjs'], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
  };
}

describe('scripts/build-avatars.mjs', () => {
  let lib: ReturnType<typeof aLibrary>;

  beforeEach(() => {
    lib = aLibrary();
  });

  afterEach(() => rmSync(lib.root, { recursive: true, force: true }));

  it('writes every size, then leaves files alone when nothing changed', () => {
    expect(lib.build()).toContain('4 WebP files, 4 built');
    const bytes = readFileSync(lib.webp);
    const writtenAt = statSync(lib.webp).mtimeMs;
    expect(lib.build()).toContain('4 WebP files, 0 built');
    expect(readFileSync(lib.webp).equals(bytes)).toBe(true);
    expect(statSync(lib.webp).mtimeMs).toBe(writtenAt);
  });

  it('rebuilds a replaced master that carries an older date than its WebP', () => {
    lib.build();
    const before = readFileSync(lib.webp);
    // What unzip, rsync -a and cp -p do with originals made before the last build.
    copyFileSync(join(BE, 'assets/avatars/male/M02.png'), lib.master);
    utimesSync(lib.master, LONG_AGO, LONG_AGO);
    expect(lib.build()).toContain('4 built');
    expect(readFileSync(lib.webp).equals(before)).toBe(false);
  });

  it('stops the build when a master the manifest lists is missing', () => {
    rmSync(lib.master);
    expect(() => lib.build()).toThrow(/M01: male\/M01\.png is listed in the manifest but missing/);
  });
});
