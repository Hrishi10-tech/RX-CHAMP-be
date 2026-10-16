import { BreakRecordRow } from '@modules/shifts/domain/break-record.repository';
import { DayDataSet } from '../application/day-data.service';
import { intervalsOfDay, meetingsOfDay, PersonDayData } from './day';
import { MeetingRecordRow } from './meeting-record.repository';
import {
  boundedStartedAt,
  checkPastMeeting,
  cleanParticipants,
  cleanText,
  isDiscardedMeeting,
  PastMeetingInput,
} from './meetings';
import { portalUrlFrom } from './portal-url';
import { WorkSessionRecord } from './work-session.repository';
import { PresenceRow } from './worktime.reader';

const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 14, h, m) - 330 * 60_000);
};

describe('checkPastMeeting', () => {
  const base = (over: Partial<PastMeetingInput> = {}): PastMeetingInput => ({
    start: ist('10:00'),
    end: ist('10:30'),
    now: ist('12:00'),
    sessions: [{ startedAt: ist('09:30'), endedAt: null }],
    breaks: [],
    meetings: [],
    ...over,
  });

  it('accepts a meeting inside an open session that ended before now', () => {
    expect(checkPastMeeting(base())).toBeNull();
    // Touching a break or another meeting is not an overlap.
    expect(
      checkPastMeeting(
        base({
          breaks: [{ type: 'BREAK', startedAt: ist('10:30'), endedAt: ist('10:45') }],
          meetings: [{ startedAt: ist('09:40'), endedAt: ist('10:00') }],
        }),
      ),
    ).toBeNull();
  });

  it('refuses one that ends after now', () => {
    expect(checkPastMeeting(base({ end: ist('12:01') }))).toEqual({ code: 'MEETING_IN_FUTURE' });
  });

  it('refuses one not entirely inside one session (the gap between two does not count)', () => {
    const sessions = [
      { startedAt: ist('09:30'), endedAt: ist('10:15') },
      { startedAt: ist('10:20'), endedAt: null },
    ];
    expect(checkPastMeeting(base({ sessions }))).toEqual({ code: 'MEETING_OUTSIDE_DAY' });
    expect(checkPastMeeting(base({ start: ist('09:00'), end: ist('09:45') }))).toEqual({
      code: 'MEETING_OUTSIDE_DAY',
    });
    expect(checkPastMeeting(base({ sessions: [] }))).toEqual({ code: 'MEETING_OUTSIDE_DAY' });
  });

  it('names the break or meeting it overlaps, breaks first', () => {
    const lunch = { type: 'LUNCH' as const, startedAt: ist('10:20'), endedAt: null };
    const meeting = { startedAt: ist('10:10'), endedAt: ist('10:40') };
    expect(checkPastMeeting(base({ breaks: [lunch], meetings: [meeting] }))).toEqual({
      code: 'MEETING_OVERLAPS_BREAK',
      with: { kind: 'LUNCH', startedAt: ist('10:20').toISOString(), endedAt: null },
    });
    expect(checkPastMeeting(base({ meetings: [meeting] }))).toEqual({
      code: 'MEETING_OVERLAPS_MEETING',
      with: {
        kind: 'MEETING',
        startedAt: ist('10:10').toISOString(),
        endedAt: ist('10:40').toISOString(),
      },
    });
  });
});

describe('meeting text and participants', () => {
  it('collapses whitespace', () => {
    expect(cleanText('  Sprint \n  review ')).toBe('Sprint review');
    expect(cleanText(null)).toBe('');
  });

  it('keeps each person once, drops blanks and unknown ids, caps names at 80', () => {
    const known = new Set(['id-1']);
    expect(
      cleanParticipants(
        [
          { id: 'id-1', name: ' Asha  Rao ' },
          { id: 'id-1', name: 'Asha again' },
          { id: 'bogus', name: 'Ravi' },
          { name: 'ravi' },
          { name: '   ' },
          { name: 'x'.repeat(100) },
        ],
        known,
      ),
    ).toEqual([{ id: 'id-1', name: 'Asha Rao' }, { name: 'Ravi' }, { name: 'x'.repeat(80) }]);
  });
});

describe('boundedStartedAt', () => {
  const now = ist('09:30');
  it('takes a start up to 10 minutes back', () => {
    expect(boundedStartedAt(ist('09:21').toISOString(), now)).toEqual(ist('09:21'));
    expect(boundedStartedAt(ist('09:20').toISOString(), now)).toEqual(ist('09:20'));
  });
  it('uses now for anything older, in the future, unreadable or missing', () => {
    expect(boundedStartedAt(ist('09:19').toISOString(), now)).toEqual(now);
    expect(boundedStartedAt(ist('09:31').toISOString(), now)).toEqual(now);
    expect(boundedStartedAt('yesterday', now)).toEqual(now);
    expect(boundedStartedAt(undefined, now)).toEqual(now);
  });
});

describe('isDiscardedMeeting', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 14, 5, m));
  const base = {
    mode: 'LIVE' as const,
    endedAt: at(1),
    approvalStatus: 'NOT_REQUIRED' as const,
    durationSec: 40,
  };
  it('a live meeting that ended under a minute, kept as NOT_REQUIRED', () => {
    expect(isDiscardedMeeting(base)).toBe(true);
    expect(isDiscardedMeeting({ ...base, durationSec: null })).toBe(true);
  });
  it('anything else is a real meeting', () => {
    expect(isDiscardedMeeting({ ...base, durationSec: 60 })).toBe(false);
    expect(isDiscardedMeeting({ ...base, endedAt: null })).toBe(false);
    expect(isDiscardedMeeting({ ...base, approvalStatus: 'PENDING' })).toBe(false);
    expect(isDiscardedMeeting({ ...base, mode: 'PAST' })).toBe(false);
  });
});

describe('portalUrlFrom', () => {
  it('prefers PORTAL_PUBLIC_URL, then the first CORS origin, never a wildcard', () => {
    expect(portalUrlFrom('https://portal.example.test/', ['http://localhost:3000'])).toBe(
      'https://portal.example.test',
    );
    expect(portalUrlFrom(undefined, ['http://localhost:3000', 'https://b.test'])).toBe(
      'http://localhost:3000',
    );
    expect(portalUrlFrom('  ', ['*'])).toBeNull();
    expect(portalUrlFrom('ftp://files.test', undefined)).toBeNull();
    expect(portalUrlFrom(undefined, undefined)).toBeNull();
  });
});

describe('a loaded day', () => {
  const session = (from: string, to: string | null): WorkSessionRecord => ({
    id: `s-${from}`,
    userId: 'u1',
    date: '2026-10-14',
    startedAt: ist(from),
    endedAt: to ? ist(to) : null,
    endReason: to ? 'USER' : null,
    source: 'AGENT',
  });
  const presence = (
    type: PresenceRow['type'],
    from: string,
    to: string | null,
    userId = 'u1',
  ): PresenceRow => ({
    id: `p-${from}-${userId}`,
    userId,
    type,
    note: null,
    date: '2026-10-14',
    startedAt: ist(from),
    endedAt: to ? ist(to) : null,
  });
  const meeting = (mode: 'LIVE' | 'PAST', from: string, to: string): MeetingRecordRow => ({
    id: `m-${from}`,
    userId: 'u1',
    date: '2026-10-14',
    mode,
    agenda: 'Review',
    participants: [],
    startedAt: ist(from),
    endedAt: ist(to),
    durationSec: null,
    presenceSessionId: null,
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: 'm1',
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    dueAt: null,
    escalatedAt: null,
    remindedAt: null,
    createdAt: ist(to),
  });
  const now = ist('18:00');

  it('counts presence meetings inside the sessions plus logged ones', () => {
    const d: PersonDayData = {
      userId: 'u1',
      date: '2026-10-14',
      sessions: [session('09:30', '13:00'), session('14:00', null)],
      presence: [
        presence('MEETING', '10:00', '11:00'),
        presence('MEETING', '13:15', '13:45'),
        presence('BREAK', '11:00', '11:15'),
      ],
      breakRecords: [] as BreakRecordRow[],
      meetingRecords: [meeting('PAST', '15:00', '15:30'), meeting('LIVE', '10:00', '11:00')],
    };
    expect(meetingsOfDay(d, now)).toEqual({ count: 2, sec: 90 * 60 });
    const iv = intervalsOfDay(d, now);
    expect(iv.work).toHaveLength(2);
    expect(iv.work[1].end).toBe(now.getTime());
    expect(iv.breaks).toHaveLength(1);
    expect(iv.meetings).toHaveLength(3);
  });

  it('does not count a presence meeting shorter than a minute (a discarded live meeting)', () => {
    const quick: PresenceRow = {
      ...presence('MEETING', '10:00', null),
      endedAt: new Date(ist('10:00').getTime() + 30_000),
    };
    const d: PersonDayData = {
      userId: 'u1',
      date: '2026-10-14',
      sessions: [session('09:30', '13:00')],
      presence: [quick, presence('MEETING', '11:00', '11:01')],
      breakRecords: [] as BreakRecordRow[],
      meetingRecords: [],
    };
    expect(meetingsOfDay(d, now)).toEqual({ count: 1, sec: 60 });
  });

  it('DayDataSet keeps only the presence overlapping that day’s sessions', () => {
    const set = new DayDataSet(
      [session('09:30', '13:00')],
      [
        presence('BREAK', '08:00', '08:30'),
        presence('BREAK', '12:50', '13:10'),
        presence('BREAK', '11:00', '11:15', 'u2'),
      ],
      [],
      [],
      now,
    );
    const d = set.day('u1', '2026-10-14');
    expect(d.presence.map((p) => p.id)).toEqual(['p-12:50-u1']);
    expect(set.day('u1', '2026-10-15')).toMatchObject({ sessions: [], presence: [] });
  });
});
