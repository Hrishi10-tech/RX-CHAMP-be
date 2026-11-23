import {
  FEATURE_FLAGS,
  FEATURE_NAMES,
  NEEDS_DATA_HANDLING,
  parseFlag,
  resolveFlags,
} from './feature-flags';

describe('release feature flags', () => {
  it('reads on/off words and falls back on anything else', () => {
    expect(parseFlag('on', false)).toBe(true);
    expect(parseFlag(' TRUE ', false)).toBe(true);
    expect(parseFlag('1', false)).toBe(true);
    expect(parseFlag('off', true)).toBe(false);
    expect(parseFlag('false', true)).toBe(false);
    expect(parseFlag('0', true)).toBe(false);
    expect(parseFlag('maybe', true)).toBe(true);
    expect(parseFlag(undefined, false)).toBe(false);
  });

  it('uses the shipped default when the environment says nothing', () => {
    const flags = resolveFlags({});
    expect(flags.dataHandling).toBe(FEATURE_FLAGS.dataHandling.default);
    for (const name of FEATURE_NAMES) {
      const needsDataHandling = NEEDS_DATA_HANDLING.includes(name);
      expect(flags[name]).toBe(
        FEATURE_FLAGS[name].default && (!needsDataHandling || flags.dataHandling),
      );
    }
  });

  it('lets a deployment switch a flag with FEATURE_<NAME>', () => {
    expect(resolveFlags({ FEATURE_MESSAGING: 'on' }).messaging).toBe(true);
    expect(resolveFlags({ FEATURE_MESSAGING: 'off' }).messaging).toBe(false);
  });

  it('keeps AI Insights, AI chat and red flags off while data handling is off', () => {
    const off = resolveFlags({
      FEATURE_AI_INSIGHTS: 'on',
      FEATURE_AI_CHAT: 'on',
      FEATURE_RED_FLAGS: 'on',
      FEATURE_DATA_HANDLING: 'off',
    });
    expect(off.aiInsights).toBe(false);
    expect(off.aiChat).toBe(false);
    expect(off.redFlags).toBe(false);

    const on = resolveFlags({
      FEATURE_AI_INSIGHTS: 'on',
      FEATURE_AI_CHAT: 'on',
      FEATURE_RED_FLAGS: 'on',
      FEATURE_DATA_HANDLING: 'on',
    });
    expect(on.aiInsights).toBe(true);
    expect(on.aiChat).toBe(true);
    expect(on.redFlags).toBe(true);
  });
});
