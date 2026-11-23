import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AVATAR_SIZES, AvatarCatalog, avatarCatalog, libraryOf } from './avatar-catalog';
import { effectiveAvatarId, withEffectiveAvatar } from './person-avatar';

const entry = (id: string, gender: string, set = 1, file = `${gender}/${id}.png`) => ({
  id,
  gender,
  set,
  file,
});
const manifest = (over: Record<string, unknown> = {}) => ({
  version: 1,
  default: { male: 'M01', female: 'F01' },
  avatars: [entry('M01', 'male'), entry('M02', 'male'), entry('F01', 'female')],
  ...over,
});

describe('AvatarCatalog', () => {
  describe('the committed library', () => {
    const catalog = avatarCatalog();

    it('lists 75 male and 75 female avatars in three sets of 25', () => {
      for (const library of ['male', 'female'] as const) {
        const own = catalog.entries.filter((e) => e.gender === library);
        expect(own).toHaveLength(75);
        for (const set of [1, 2, 3]) {
          expect(own.filter((e) => e.set === set)).toHaveLength(25);
        }
      }
    });

    it('defaults to M01 and F01', () => {
      expect(catalog.defaults).toEqual({ male: 'M01', female: 'F01' });
    });
  });

  describe('validation', () => {
    const dir = '/nowhere';

    it('takes a good manifest', () => {
      expect(new AvatarCatalog(manifest(), dir).entries).toHaveLength(3);
    });

    it.each<[string, unknown, RegExp]>([
      ['not an object', 'nope', /not an object/],
      ['no version', manifest({ version: undefined }), /version/],
      ['no avatars', manifest({ avatars: [] }), /empty/],
      ['a bad id', manifest({ avatars: [entry('../M01', 'male')] }), /bad id/],
      ['a bad gender', manifest({ avatars: [entry('M01', 'other')] }), /bad gender/],
      ['a bad set', manifest({ avatars: [entry('M01', 'male', 0)] }), /bad set/],
      [
        'a file outside the library',
        manifest({ avatars: [entry('M01', 'male', 1, '../../etc/passwd')] }),
        /bad file/,
      ],
      [
        'an id listed twice',
        manifest({ avatars: [entry('M01', 'male'), entry('M01', 'male')] }),
        /twice/,
      ],
      ['no defaults', manifest({ default: undefined }), /default/],
      [
        'a default that does not exist',
        manifest({ default: { male: 'M99', female: 'F01' } }),
        /male default/,
      ],
      [
        'a default from the other library',
        manifest({ default: { male: 'F01', female: 'F01' } }),
        /male default/,
      ],
    ])('refuses %s', (_name, raw, message) => {
      expect(() => new AvatarCatalog(raw, dir)).toThrow(message);
    });
  });

  describe('what a person shows', () => {
    const catalog = new AvatarCatalog(manifest(), '/nowhere');

    it('is the choice while it fits their library', () => {
      expect(catalog.effective('MALE', 'M02')).toBe('M02');
    });

    it('is the default for their gender without a choice', () => {
      expect(catalog.effective('MALE', null)).toBe('M01');
      expect(catalog.effective('FEMALE', null)).toBe('F01');
    });

    it('falls back to the default for a stored ID that is gone or from the other library', () => {
      expect(catalog.effective('MALE', 'M99')).toBe('M01');
      expect(catalog.effective('FEMALE', 'M02')).toBe('F01');
    });

    it('is nothing while the person has no gender', () => {
      expect(catalog.effective(null, null)).toBeNull();
      expect(catalog.effective(undefined, 'M02')).toBeNull();
    });

    it('names the library of a gender', () => {
      expect(libraryOf('MALE')).toBe('male');
      expect(libraryOf('FEMALE')).toBe('female');
      expect(libraryOf(null)).toBeNull();
    });
  });

  describe('files on disk', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'avatars-'));
      mkdirSync(join(dir, 'male'));
      mkdirSync(join(dir, 'female'));
      for (const name of ['male/M01.png', 'male/M02.png', 'female/F01.png']) {
        writeFileSync(join(dir, name), 'png');
      }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest()));
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const writeWebp = (size: number, id: string, content: string) => {
      mkdirSync(join(dir, 'webp', String(size)), { recursive: true });
      writeFileSync(join(dir, 'webp', String(size), `${id}.webp`), content);
    };

    it('stops the boot when a master is missing', () => {
      rmSync(join(dir, 'male/M02.png'));
      expect(() => AvatarCatalog.load(dir)).toThrow(/M02.png is missing/);
    });

    it('finds a generated file only for a real size and a manifest ID', () => {
      writeWebp(48, 'M01', 'a');
      writeWebp(48, 'evil', 'b');
      const catalog = AvatarCatalog.load(dir);
      expect(catalog.webpPath(48, 'M01')).toBe(join(dir, 'webp', '48', 'M01.webp'));
      expect(catalog.webpPath(49, 'M01')).toBeNull();
      expect(catalog.webpPath(Number('x'), 'M01')).toBeNull();
      expect(catalog.webpPath(48, 'evil')).toBeNull();
      expect(catalog.webpPath(48, '../../manifest')).toBeNull();
      expect(catalog.webpPath(96, 'M01')).toBeNull();
    });

    it('hashes the content, so a replaced file gets a new URL', () => {
      writeWebp(48, 'M01', 'first');
      const first = AvatarCatalog.load(dir).contentHash(48, 'M01');
      writeWebp(48, 'M01', 'second');
      const second = AvatarCatalog.load(dir).contentHash(48, 'M01');
      expect(first).toMatch(/^[0-9a-f]{12}$/);
      expect(second).not.toBe(first);
    });

    it('counts what was not generated', () => {
      writeWebp(48, 'M01', 'a');
      const catalog = AvatarCatalog.load(dir);
      expect(catalog.contentHash(96, 'M01')).toBeNull();
      expect(catalog.missingFiles()).toBe(3 * AVATAR_SIZES.length - 1);
    });
  });

  describe('a person row', () => {
    it('swaps the raw columns for the effective avatar and drops the gender', () => {
      const row = { id: 'u', firstName: 'A', gender: 'FEMALE' as const, avatarId: null };
      expect(withEffectiveAvatar(row)).toEqual({ id: 'u', firstName: 'A', avatarId: 'F01' });
      expect(withEffectiveAvatar(row)).not.toHaveProperty('gender');
    });

    it('works out the effective avatar', () => {
      expect(effectiveAvatarId({ gender: 'MALE', avatarId: 'M12' })).toBe('M12');
      expect(effectiveAvatarId({ gender: null, avatarId: null })).toBeNull();
      expect(effectiveAvatarId({})).toBeNull();
    });
  });
});
