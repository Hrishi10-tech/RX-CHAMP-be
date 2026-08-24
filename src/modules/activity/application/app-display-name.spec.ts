import { appDisplayName } from './app-display-name';

describe('appDisplayName', () => {
  it('renames the agent to the product name', () => {
    expect(appDisplayName('TimeChampAgent')).toBe('RX Vision Agent');
  });

  it('matches regardless of case or padding, since the name comes from a process', () => {
    expect(appDisplayName('timechampagent')).toBe('RX Vision Agent');
    expect(appDisplayName('  TimeChampAgent  ')).toBe('RX Vision Agent');
  });

  it('leaves every other app alone', () => {
    expect(appDisplayName('Google Chrome')).toBe('Google Chrome');
    expect(appDisplayName('Visual Studio Code')).toBe('Visual Studio Code');
  });

  it('passes null and empty through', () => {
    expect(appDisplayName(null)).toBeNull();
    expect(appDisplayName('')).toBe('');
  });
});
