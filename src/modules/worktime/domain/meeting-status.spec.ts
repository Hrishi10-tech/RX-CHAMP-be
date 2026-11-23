import {
  STATUS_MEETING_FALLBACK_MS,
  STATUS_MEETING_PROMPT_MS,
  statusCutoff,
  statusFallbackAt,
  statusFallbackDue,
  statusPromptAt,
} from './meeting-status';

const at = (hhmm: string) => new Date(`2026-11-05T${hhmm}:00+05:30`);

describe('the 2 hour check (brief 1.8)', () => {
  it('asks after 2 hours and falls back 10 minutes later', () => {
    expect(STATUS_MEETING_PROMPT_MS).toBe(2 * 3_600_000);
    expect(STATUS_MEETING_FALLBACK_MS).toBe(10 * 60_000);
    expect(statusPromptAt(at('10:00'))).toEqual(at('12:00'));
    expect(statusFallbackAt(at('10:00'))).toEqual(at('12:10'));
  });

  it('is due at exactly the fallback moment, not a second before', () => {
    const confirmed = at('10:00');
    expect(statusFallbackDue(confirmed, new Date(at('12:10').getTime() - 1000))).toBe(false);
    expect(statusFallbackDue(confirmed, at('12:10'))).toBe(true);
    expect(statusFallbackDue(confirmed, at('12:11'))).toBe(true);
  });

  it('a confirmation at or before the cutoff is unanswered', () => {
    expect(statusCutoff(at('12:10'))).toEqual(at('10:00'));
  });

  it('each confirmation starts the 2 hours again', () => {
    expect(statusPromptAt(at('12:05'))).toEqual(at('14:05'));
    expect(statusFallbackAt(at('12:05'))).toEqual(at('14:15'));
  });
});
