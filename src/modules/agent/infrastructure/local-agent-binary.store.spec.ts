import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, parse } from 'path';
import configuration from '@shared/config/configuration';
import { LocalAgentBinaryStore } from './local-agent-binary.store';

const UNAVAILABLE = { available: false, sizeBytes: 0, isDirectory: false };

/**
 * NV-01: an empty AGENT_BINARY_PATH used to resolve to the working directory,
 * which the download route then served as a zip (environment file included).
 * An empty path means "no local build", and the working directory or anything
 * above it is never served as a publish folder.
 */
describe('LocalAgentBinaryStore', () => {
  let root: string;
  let work: string;
  let cwd: jest.SpyInstance;

  beforeAll(() => {
    // <root>/server is the working directory; <root>/server/publish and
    // <root>/builds are places a real agent build could be.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'rxv-agent-store-')));
    work = join(root, 'server');
    mkdirSync(join(work, 'publish'), { recursive: true });
    mkdirSync(join(root, 'builds'));
    writeFileSync(join(work, 'secret.marker'), 'dummy');
    writeFileSync(join(work, 'publish', 'RXVision.exe'), 'dummy agent');
    writeFileSync(join(root, 'builds', 'RXVision.exe'), 'dummy agent');
    // A junction on Windows: a directory symlink there needs admin rights or Developer Mode.
    symlinkSync(
      work,
      join(root, 'link-to-server'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    cwd = jest.spyOn(process, 'cwd').mockReturnValue(work);
  });

  afterEach(() => {
    cwd.mockRestore();
  });

  it.each([
    ['an empty path', ''],
    ['a path of spaces', '   '],
    ['a tab and a line break', '\t\n'],
  ])('treats %s as no local build', async (_what, configured) => {
    const store = new LocalAgentBinaryStore(configured);

    await expect(store.info()).resolves.toEqual(UNAVAILABLE);
    expect(store.directoryPath()).toBeNull();
    await expect(store.openStream()).rejects.toThrow('No local agent build is configured');
  });

  it('treats a missing configured path as no local build', async () => {
    const store = new LocalAgentBinaryStore(undefined as unknown as string);

    await expect(store.info()).resolves.toEqual(UNAVAILABLE);
    expect(store.directoryPath()).toBeNull();
  });

  it.each([
    ['"."', () => '.'],
    ['"./"', () => './'],
    ['" . " (spaces around a dot)', () => ' . '],
    ['the working directory by its full path', () => work],
    ['".." (the parent)', () => '..'],
    ['an ancestor by its full path', () => dirname(root)],
    ['the filesystem root', () => parse(work).root],
    ['a symbolic link to the working directory', () => join(root, 'link-to-server')],
  ])('never serves %s as a publish folder', async (_what, configured) => {
    const store = new LocalAgentBinaryStore(configured());

    await expect(store.info()).resolves.toEqual(UNAVAILABLE);
    expect(store.directoryPath()).toBeNull();
  });

  it('serves a publish folder under the working directory, given as a relative path', async () => {
    const store = new LocalAgentBinaryStore('publish');

    await expect(store.info()).resolves.toEqual({
      available: true,
      sizeBytes: 0,
      isDirectory: true,
    });
    expect(store.directoryPath()).toBe(join(work, 'publish'));
  });

  it('serves a publish folder elsewhere on the disk', async () => {
    const store = new LocalAgentBinaryStore(join(root, 'builds'));

    await expect(store.info()).resolves.toMatchObject({ available: true, isDirectory: true });
    expect(store.directoryPath()).toBe(join(root, 'builds'));
  });

  it('serves a single file with its size and hash', async () => {
    const store = new LocalAgentBinaryStore('publish/RXVision.exe');

    await expect(store.info()).resolves.toEqual({
      available: true,
      sizeBytes: 11,
      isDirectory: false,
      sha256: createHash('sha256').update('dummy agent').digest('hex'),
    });
    expect(store.directoryPath()).toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of await store.openStream()) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('dummy agent');
  });

  it('reports a path that does not exist as unavailable', async () => {
    const store = new LocalAgentBinaryStore('timechamp-agent-installer/publish/RXChampAgent.exe');

    await expect(store.info()).resolves.toEqual(UNAVAILABLE);
    expect(store.directoryPath()).toBeNull();
  });
});

describe('AGENT_BINARY_PATH in the configuration', () => {
  const DEFAULT_PATH = 'timechamp-agent-installer/publish/RXChampAgent.exe';
  const before = process.env.AGENT_BINARY_PATH;

  afterEach(() => {
    if (before === undefined) delete process.env.AGENT_BINARY_PATH;
    else process.env.AGENT_BINARY_PATH = before;
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
  ])('falls back to the default when the variable is %s', (_what, value) => {
    process.env.AGENT_BINARY_PATH = value;
    expect(configuration().agent.binaryPath).toBe(DEFAULT_PATH);
  });

  it('falls back to the default when the variable is not set', () => {
    delete process.env.AGENT_BINARY_PATH;
    expect(configuration().agent.binaryPath).toBe(DEFAULT_PATH);
  });

  it('keeps a configured path', () => {
    process.env.AGENT_BINARY_PATH = '/srv/rxvision/agent/publish';
    expect(configuration().agent.binaryPath).toBe('/srv/rxvision/agent/publish');
  });
});
