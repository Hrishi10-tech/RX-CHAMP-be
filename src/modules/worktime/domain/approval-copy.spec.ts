import {
  APPROVAL_CATEGORIES,
  approvalEffect,
  AWAY_KIND_LABEL,
  awayCategory,
  awayDetail,
  awayTitle,
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
      'Skipped at 11:02 AM · window 10:30 AM to 12:00 PM',
    );
    const auto = { ...base, startedAt: ist('12:00'), endedAt: ist('12:00') };
    expect(breakTitle('BREAK_AUTO_SKIP', auto)).toBe('Morning break auto-skipped');
    expect(breakDetail('BREAK_AUTO_SKIP', auto, TZ, now)).toBe(
      'Auto-skipped at 12:00 PM · window 10:30 AM to 12:00 PM',
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
    expect(breakDetail('BREAK_OVERRUN', lunch, TZ, now)).toBe('1:05 PM to 1:50 PM · 45 min of 30');
    expect(breakTitle('BREAK_OVERRUN', { ...lunch, kind: 'EVENING', presenceType: 'BREAK' })).toBe(
      'Back 15 min late from the evening break',
    );
  });

  it('names late and early starts', () => {
    const late = { ...base, minutesOff: 20, startedAt: ist('11:20'), endedAt: ist('11:35') };
    expect(breakTitle('BREAK_LATE', late)).toBe('Morning break started 20 min late');
    expect(breakDetail('BREAK_LATE', late, TZ, now)).toBe('Started 11:20 AM · due 11:00 AM · 15 min');
    expect(breakDetail('BREAK_LATE', { ...late, endedAt: null }, TZ, now)).toBe(
      'Started 11:20 AM · due 11:00 AM · on a break now',
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
    ).toBe('10:00 AM to 10:45 AM · 45 min · 3 people');
    expect(
      meetingDetail(
        { startedAt: ist('10:00'), endedAt: null, durationSec: 60, participants: 1 },
        TZ,
      ),
    ).toBe('Started 10:00 AM · in progress · 1 person');
  });
});

describe('times read as 12-hour h:mm AM/PM (4.0)', () => {
  it('formats midnight, noon and afternoon times without a 24-hour clock', () => {
    const r = { ...base, kind: null, startedAt: ist('00:05'), endedAt: ist('12:30') };
    expect(breakDetail('BREAK_UNSCHEDULED', r, TZ, ist('14:00'))).toBe('12:05 AM to 12:30 PM · 745 min');
    expect(breakDetail('BREAK_OUTSIDE', { ...r, startedAt: ist('15:00'), endedAt: null }, TZ, ist('16:00'))).toBe(
      'Started 3:00 PM · on a break now',
    );
    const texts = [
      breakDetail('BREAK_SKIP', base, TZ, ist('14:00')),
      breakDetail('BREAK_OVERRUN', { ...base, startedAt: ist('13:05'), endedAt: ist('13:50') }, TZ, ist('14:00')),
      meetingDetail({ startedAt: ist('16:00'), endedAt: ist('17:15'), durationSec: 4500, participants: 0 }, TZ),
      awayDetail({ startedAt: ist('14:05'), endedAt: ist('14:30'), seconds: 1500, participants: 0, momSender: null }, TZ),
    ];
    for (const t of texts) {
      expect(t).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
      expect(t).not.toMatch(/\b(1[3-9]|2[0-3]|0\d):\d{2}\b/);
    }
  });

  it('an overrun still open is measured to now', () => {
    const open = { ...base, kind: 'LUNCH' as const, startedAt: ist('13:00'), endedAt: null, durationMin: 30 };
    expect(breakDetail('BREAK_OVERRUN', open, TZ, ist('13:45'))).toBe('1:00 PM to 1:45 PM · 45 min of 30');
  });
});

describe('away items (4.0)', () => {
  it('maps every away kind to its category, unknown kinds to Other work', () => {
    expect(awayCategory('THINKING')).toBe('AWAY_THINKING');
    expect(awayCategory('MEETING')).toBe('AWAY_MEETING');
    expect(awayCategory('HARDWARE')).toBe('AWAY_HARDWARE');
    expect(awayCategory('OTHER')).toBe('AWAY_OTHER');
    expect(awayCategory('CUSTOM')).toBe('AWAY_CUSTOM');
    expect(awayCategory(null)).toBe('AWAY_OTHER');
    expect(awayCategory('SOMETHING_NEW')).toBe('AWAY_OTHER');
    for (const c of ['AWAY_THINKING', 'AWAY_MEETING', 'AWAY_HARDWARE', 'AWAY_OTHER', 'AWAY_CUSTOM']) {
      expect(APPROVAL_CATEGORIES).toContain(c);
    }
  });

  it('has the SPEC 5.7 default labels', () => {
    expect(AWAY_KIND_LABEL).toMatchObject({
      THINKING: 'Thinking',
      MEETING: 'Short meeting',
      HARDWARE: 'Working on hardware',
      OTHER: 'Other work',
    });
  });

  it('titles an away item by its minutes and label (a renamed or custom label wins)', () => {
    expect(awayTitle(null, 'THINKING', 25 * 60)).toBe('Away 25 min: Thinking');
    expect(awayTitle('  ', 'MEETING', 10 * 60)).toBe('Away 10 min: Short meeting');
    expect(awayTitle('Soldering the gateway', 'CUSTOM', 30)).toBe('Away 1 min: Soldering the gateway');
    expect(awayTitle(null, null, 0)).toBe('Away 0 min: Other work');
  });

  it('details an away item with 12-hour times, people and the minutes sender', () => {
    expect(
      awayDetail({ startedAt: ist('14:05'), endedAt: ist('14:30'), seconds: 1500, participants: 0, momSender: null }, TZ),
    ).toBe('2:05 PM to 2:30 PM · 25 min');
    expect(
      awayDetail({ startedAt: ist('09:50'), endedAt: ist('10:10'), seconds: 1200, participants: 1, momSender: 'Asha' }, TZ),
    ).toBe('9:50 AM to 10:10 AM · 20 min · 1 person · minutes by Asha');
    // No end yet: the end is the start plus the seconds.
    expect(
      awayDetail({ startedAt: ist('11:00'), endedAt: null, seconds: 600, participants: 3, momSender: null }, TZ),
    ).toBe('11:00 AM to 11:10 AM · 10 min · 3 people');
  });

  it('an away item adds focus when approved (PLUS) and changes nothing when rejected', () => {
    for (const c of ['AWAY_THINKING', 'AWAY_MEETING', 'AWAY_HARDWARE', 'AWAY_OTHER', 'AWAY_CUSTOM'] as const) {
      expect(approvalEffect(c, 'PENDING', 20)).toEqual({ mode: 'PLUS', minutes: 20, text: '+20 min if approved' });
      expect(approvalEffect(c, 'APPROVED', 20)).toEqual({ mode: 'PLUS', minutes: 20, text: '+20 min added' });
      expect(approvalEffect(c, 'REJECTED', 20)).toEqual({ mode: 'NONE', minutes: 0, text: 'No change to focus time' });
      expect(approvalEffect(c, 'NOT_REQUIRED', 20).mode).toBe('NONE');
    }
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
      'Waiting on Maya Reddy and Arjun Rao. You can decide them in Approvals.',
    );
    expect(texts[7].title).toBe('September 2026 report is ready');
    for (const t of texts) expect(`${t.title} ${t.body}`).not.toMatch(/[—!]/);
  });

  it('lists names briefly and formats months and sentences', () => {
    expect(namesList([])).toBe('the Admin');
    expect(namesList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(namesList(['A', 'B', 'C', 'D', 'E'])).toBe('A, B and 3 others');
    expect(monthName('2026-12')).toBe('December 2026');
    expect(asSentence('Done.')).toBe('Done.');
    expect(asSentence('Done')).toBe('Done.');
  });
});
