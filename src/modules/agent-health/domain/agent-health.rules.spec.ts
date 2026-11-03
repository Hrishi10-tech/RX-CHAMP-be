import { agentVersionLabel, healthFlags, HealthFacts, liveStatus } from './agent-health.rules';

const NOW = new Date('2026-11-03T06:00:00Z'); // 11:30 IST
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);

function facts(over: Partial<HealthFacts> = {}): HealthFacts {
  return {
    now: NOW,
    lastContactAt: min(1),
    lastSampleAt: min(1),
    lastSampleIdle: false,
    signedIn: true,
    agentVersion: '3.2.0',
    dayState: 'OPEN',
    dayStartedAt: min(120),
    workday: true,
    shiftStart: min(150),
    screenshotsEnabled: true,
    lastShotAt: min(8),
    shotsToday: 12,
    lastRefusalAt: null,
    dayStart: new Date('2026-11-02T18:30:00Z'),
    ...over,
  };
}

describe('healthFlags', () => {
  it('is empty for a healthy, tracking person', () => {
    expect(healthFlags(facts())).toEqual([]);
  });

  it('names a person whose agent never called', () => {
    expect(
      healthFlags(
        facts({
          lastContactAt: null,
          lastSampleAt: null,
          dayState: 'NOT_STARTED',
          dayStartedAt: null,
          signedIn: false,
          agentVersion: null,
        }),
      ),
    ).toEqual(['NEVER_REPORTED', 'SIGNED_OUT']);
  });

  it('flags an open day whose agent went quiet', () => {
    expect(healthFlags(facts({ lastContactAt: min(6), lastSampleAt: min(6) }))).toEqual([
      'AGENT_OFFLINE',
    ]);
    // Quiet for a moment is not offline.
    expect(healthFlags(facts({ lastContactAt: min(4), lastSampleAt: min(4) }))).toEqual([]);
  });

  it('flags a running agent on a working day with no Start Day after the shift began', () => {
    const base = {
      dayState: 'NOT_STARTED' as const,
      dayStartedAt: null,
      lastSampleAt: null,
      shotsToday: 0,
      lastShotAt: null,
    };
    expect(healthFlags(facts(base))).toEqual(['DAY_NOT_STARTED']);
    // Not yet: the shift started 10 minutes ago.
    expect(healthFlags(facts({ ...base, shiftStart: min(10) }))).toEqual([]);
    // A day off, or no shift, or an agent that is not running: nothing to chase.
    expect(healthFlags(facts({ ...base, workday: false }))).toEqual([]);
    expect(healthFlags(facts({ ...base, shiftStart: null }))).toEqual([]);
    expect(healthFlags(facts({ ...base, lastContactAt: min(40) }))).toEqual([]);
  });

  it('flags missing and stalled screenshots only while they could be arriving', () => {
    expect(healthFlags(facts({ shotsToday: 0, lastShotAt: null }))).toEqual([
      'NO_SCREENSHOTS_TODAY',
    ]);
    // The day only just started: give it time.
    expect(healthFlags(facts({ shotsToday: 0, lastShotAt: null, dayStartedAt: min(10) }))).toEqual(
      [],
    );
    // An ended day with nothing at all is still worth a look.
    expect(
      healthFlags(
        facts({
          shotsToday: 0,
          lastShotAt: null,
          dayState: 'ENDED',
          lastContactAt: min(300),
          lastSampleAt: min(300),
        }),
      ),
    ).toEqual(['NO_SCREENSHOTS_TODAY']);
    expect(healthFlags(facts({ lastShotAt: min(50) }))).toEqual(['SCREENSHOTS_STALE']);
    // Offline explains the gap; stale is not added on top.
    expect(
      healthFlags(facts({ lastShotAt: min(50), lastContactAt: min(20), lastSampleAt: min(20) })),
    ).toEqual(['AGENT_OFFLINE']);
    // Switched off: that is the whole story.
    expect(
      healthFlags(facts({ screenshotsEnabled: false, shotsToday: 0, lastShotAt: null })),
    ).toEqual(['SCREENSHOTS_OFF']);
  });

  it('flags a refusal until a later upload gets through', () => {
    expect(healthFlags(facts({ lastRefusalAt: min(3) }))).toEqual(['UPLOAD_REFUSED']);
    expect(healthFlags(facts({ lastRefusalAt: min(30), lastShotAt: min(8) }))).toEqual([]);
    // Yesterday's refusal does not flag today.
    expect(
      healthFlags(
        facts({ lastRefusalAt: new Date('2026-11-02T10:00:00Z'), shotsToday: 0, lastShotAt: null }),
      ),
    ).toEqual(['NO_SCREENSHOTS_TODAY']);
  });

  it('flags a legacy agent that is calling', () => {
    expect(healthFlags(facts({ agentVersion: 'legacy' }))).toEqual(['OLD_AGENT']);
  });
});

describe('liveStatus and agentVersionLabel', () => {
  it('follows the newest contact or sample', () => {
    expect(liveStatus(facts())).toBe('ACTIVE');
    expect(liveStatus(facts({ lastSampleIdle: true }))).toBe('IDLE');
    expect(liveStatus(facts({ lastContactAt: min(3), lastSampleAt: min(3) }))).toBe('OFFLINE');
    expect(liveStatus(facts({ lastContactAt: null, lastSampleAt: null }))).toBe('NEVER');
    // A 3.1 agent before Start Day: contacts but no samples.
    expect(liveStatus(facts({ lastSampleAt: null }))).toBe('ACTIVE');
  });

  it('reads the version out of the agent User-Agent only', () => {
    expect(agentVersionLabel('RXVisionAgent/3.2.1 (Windows)')).toBe('3.2.1');
    expect(agentVersionLabel('RXVisionAgent/3.1 (macOS)')).toBe('3.1');
    expect(agentVersionLabel('Mozilla/5.0')).toBeNull();
    expect(agentVersionLabel(null)).toBeNull();
  });
});
