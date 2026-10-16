import {
  approvalEffect,
  breakCategory,
  breakDetail,
  breakTitle,
  meetingCategory,
  meetingDetail,
  meetingTitle,
  MINUS,
  wholeMinutes,
} from './approval-copy';
import {
  asSentence,
  autoSkipRequestedCopy,
  dayAutoClosedManagerCopy,
  dueSoonCopy,
  escalatedCopy,
  meetingDecidedCopy,
  monthName,
  monthlyReportCopy,
  namesList,
  overdueCopy,
  skipRequestedCopy,
} from './notice-copy';

const TZ = 'Asia/Kolkata';
const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 13, h, m) - 330 * 60_000);
};

const base = {
  kind: 'MORNING' as const,
  presenceType: 'BREAK' as const,
  minutesOff: 0,
  startedAt: ist('11:02'),
  endedAt: ist('11:02'),
  scheduledStart: ist('11:00'),
  durationMin: 15,
  windowOpen: ist('10:30'),
  windowClose: ist('12:00'),
  overrunSec: 0,
};

describe('approval categories', () => {
  it('lets the overrun win over early or late', () => {
    expect(breakCategory({ outcome: 'TAKEN', overrunAsked: true, timing: 'LATE' })).toBe(
      'BREAK_OVERRUN',
    );
    expect(breakCategory({ outcome: 'TAKEN', overrunAsked: false, timing: 'LATE' })).toBe(
      'BREAK_LATE',
    );
    expect(breakCategory({ outcome: 'TAKEN', overrunAsked: false, timing: 'EARLY' })).toBe(
      'BREAK_EARLY',
    );
    expect(breakCategory({ outcome: 'TAKEN', overrunAsked: false, timing: 'OUTSIDE_WINDOW' })).toBe(
      'BREAK_OUTSIDE',
    );
    expect(breakCategory({ outcome: 'TAKEN', overrunAsked: false, timing: 'UNSCHEDULED' })).toBe(
      'BREAK_UNSCHEDULED',
    );
    expect(breakCategory({ outcome: 'TAKEN', overrunAsked: false, timing: 'ON_TIME' })).toBe(
      'BREAK_OVERRUN',
    );
    expect(breakCategory({ outcome: 'SKIPPED', overrunAsked: false, timing: 'LATE' })).toBe(
      'BREAK_SKIP',
    );
    expect(
      breakCategory({ outcome: 'AUTO_SKIPPED', overrunAsked: false, timing: 'OUTSIDE_WINDOW' }),
    ).toBe('BREAK_AUTO_SKIP');
    expect(meetingCategory('LIVE')).toBe('MEETING_LIVE');
    expect(meetingCategory('PAST')).toBe('MEETING_PAST');
  });
});

describe('approval effects', () => {
  it('says what a decision would do while pending', () => {
    expect(approvalEffect('BREAK_OVERRUN', 'PENDING', 15)).toEqual({
      mode: 'PLUS',
      minutes: 15,
      text: '+15 min if approved',
    });
    expect(approvalEffect('BREAK_SKIP', 'PENDING', 15)).toEqual({
      mode: 'MINUS',
      minutes: 15,
      text: `${MINUS}15 min if rejected`,
    });
    expect(approvalEffect('MEETING_PAST', 'PENDING', 45).text).toBe(`${MINUS}45 min if rejected`);
    expect(approvalEffect('BREAK_LATE', 'PENDING', 0)).toEqual({
      mode: 'NONE',
      minutes: 0,
      text: 'No change to focus time',
    });
  });

  it('says what a decision did', () => {
    expect(approvalEffect('BREAK_OVERRUN', 'APPROVED', 15).text).toBe('+15 min added');
    expect(approvalEffect('BREAK_OVERRUN', 'REJECTED', 15).text).toBe('No change to focus time');
    expect(approvalEffect('BREAK_AUTO_SKIP', 'REJECTED', 15)).toEqual({
      mode: 'MINUS',
      minutes: 15,
      text: `${MINUS}15 min taken off`,
    });
    expect(approvalEffect('MEETING_LIVE', 'APPROVED', 30).text).toBe('Counted as focus time');
    expect(approvalEffect('BREAK_EARLY', 'APPROVED', 0).text).toBe('No change to focus time');
  });

  it('uses the real minus sign and never an em dash', () => {
    const all = ['PENDING', 'APPROVED', 'REJECTED'].flatMap((s) =>
      ['BREAK_SKIP', 'MEETING_PAST', 'BREAK_OVERRUN'].map(
        (c) => approvalEffect(c as 'BREAK_SKIP', s as 'PENDING', 5).text,
      ),
    );
    expect(all.join(' ')).not.toMatch(/[—!]|-\d/);
  });

  it('rounds minutes but never shows 0 for real time', () => {
    expect(wholeMinutes(0)).toBe(0);
    expect(wholeMinutes(10)).toBe(1);
    expect(wholeMinutes(89)).toBe(1);
    expect(wholeMinutes(91)).toBe(2);
  });
});

describe('titles and details', () => {
  const now = ist('14:00');

  it('names skips and their window', () => {
    expect(breakTitle('BREAK_SKIP', base)).toBe('Morning break skipped');
    expect(breakDetail('BREAK_SKIP', base, TZ, now)).toBe(
      'Skipped at 11:02 · window 10:30 to 12:00',
    );
    const auto = { ...base, startedAt: ist('12:00'), endedAt: ist('12:00') };
    expect(breakTitle('BREAK_AUTO_SKIP', auto)).toBe('Morning break auto-skipped');
    expect(breakDetail('BREAK_AUTO_SKIP', auto, TZ, now)).toBe(
      'Auto-skipped at 12:00 · window 10:30 to 12:00',
    );
  });

  it('names an overrun by how late the person came back', () => {
    const lunch = {
      ...base,
      kind: 'LUNCH' as const,
      presenceType: 'LUNCH' as const,
      startedAt: ist('13:05'),
      endedAt: ist('13:50'),
      durationMin: 30,
      overrunSec: 15 * 60,
    };
    expect(breakTitle('BREAK_OVERRUN', lunch)).toBe('Back 15 min late from lunch');
    expect(breakDetail('BREAK_OVERRUN', lunch, TZ, now)).toBe('13:05 to 13:50 · 45 min of 30');
    expect(breakTitle('BREAK_OVERRUN', { ...lunch, kind: 'EVENING', presenceType: 'BREAK' })).toBe(
      'Back 15 min late from the evening break',
    );
  });

  it('names late and early starts', () => {
    const late = { ...base, minutesOff: 20, startedAt: ist('11:20'), endedAt: ist('11:35') };
    expect(breakTitle('BREAK_LATE', late)).toBe('Morning break started 20 min late');
    expect(breakDetail('BREAK_LATE', late, TZ, now)).toBe('Started 11:20 · due 11:00 · 15 min');
    expect(breakDetail('BREAK_LATE', { ...late, endedAt: null }, TZ, now)).toBe(
      'Started 11:20 · due 11:00 · on a break now',
    );
    expect(breakTitle('BREAK_EARLY', { ...late, minutesOff: 10 })).toBe(
      'Morning break started 10 min early',
    );
    expect(breakTitle('BREAK_OUTSIDE', { ...base, kind: null })).toBe(
      'Break outside the break windows',
    );
    expect(breakTitle('BREAK_UNSCHEDULED', { ...base, kind: null, presenceType: 'LUNCH' })).toBe(
      'Unscheduled lunch',
    );
  });

  it('names meetings', () => {
    expect(meetingTitle('  Sprint review ')).toBe('Meeting: Sprint review');
    expect(meetingTitle('x'.repeat(100))).toHaveLength(9 + 80);
    expect(
      meetingDetail(
        { startedAt: ist('10:00'), endedAt: ist('10:45'), durationSec: 2700, participants: 3 },
        TZ,
      ),
    ).toBe('10:00 to 10:45 · 45 min · 3 people');
    expect(
      meetingDetail(
        { startedAt: ist('10:00'), endedAt: null, durationSec: 60, participants: 1 },
        TZ,
      ),
    ).toBe('Started 10:00 · in progress · 1 person');
  });
});

describe('notification copy', () => {
  it('names the person and keeps to plain sentences', () => {
    const texts = [
      skipRequestedCopy({ name: 'Asha Rao', kind: 'MORNING', reason: 'Client call' }),
      skipRequestedCopy({ name: 'Asha Rao', kind: 'MORNING', reason: null }),
      autoSkipRequestedCopy({ name: 'Asha Rao', kind: 'LUNCH', at: '14:00' }),
      meetingDecidedCopy({
        approved: false,
        date: '2026-10-13',
        deciderName: 'Maya Reddy',
        note: 'No',
      }),
      dueSoonCopy(1),
      overdueCopy(3, 48),
      escalatedCopy(4, 48, ['Maya Reddy', 'Arjun Rao', 'Maya Reddy']),
      monthlyReportCopy('2026-09', 'ALL'),
      dayAutoClosedManagerCopy({ name: 'Asha Rao', closedAt: '18:45' }),
    ];
    expect(texts[0]).toEqual({
      title: 'Asha Rao skipped the morning break',
      body: 'Reason: Client call. Review it in Approvals.',
    });
    expect(texts[2].title).toBe("Asha Rao's lunch break was auto-skipped");
    expect(texts[3].title).toBe('Your meeting on 13 Oct was rejected');
    expect(texts[4].title).toBe('1 approval is due within 12 hours');
    expect(texts[5].title).toBe('3 approvals are past 48 hours');
    expect(texts[6].body).toBe(
      'Waiting on Maya Reddy and Arjun Rao. Any Super Admin can decide them in Approvals.',
    );
    expect(texts[7].title).toBe('September 2026 report is ready');
    for (const t of texts) expect(`${t.title} ${t.body}`).not.toMatch(/[—!]/);
  });

  it('lists names briefly and formats months and sentences', () => {
    expect(namesList([])).toBe('the Super Admins');
    expect(namesList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(namesList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 others');
    expect(monthName('2026-12')).toBe('December 2026');
    expect(asSentence('Done.')).toBe('Done.');
    expect(asSentence('Done')).toBe('Done.');
  });
});
