import { Workbook } from 'exceljs';
import { emptyTotals } from '../domain/report-builder';
import { PersonDaySummary, PersonMonthReport } from '../domain/report.types';
import {
  exportFileName,
  payrollWorkbook,
  Timesheet,
  timesheetFileName,
  timesheetWorkbook,
} from './report-export';

const TZ = 'Asia/Kolkata';
const H = 3600;

function daySummary(over: Partial<PersonDaySummary>): PersonDaySummary {
  return {
    date: '2026-09-01',
    weekday: 2,
    workday: true,
    dayClass: 'FULL',
    startedAt: null,
    endedAt: null,
    autoClosed: false,
    lateStart: null,
    focusSec: 0,
    expectedSec: 8 * H,
    breakSec: 0,
    meetingSec: 0,
    approvedPlusSec: 0,
    rejectedMinusSec: 0,
    pendingPlusSec: 0,
    pendingMinusSec: 0,
    breaksTaken: 0,
    skipped: 0,
    autoSkipped: 0,
    overruns: 0,
    meetings: 0,
    pending: 0,
    quietHours: 0,
    activeMin: 0,
    label: null,
    targetSec: 7.5 * H,
    paidBreakSec: 0,
    unpaidBreakSec: 0,
    awayApprovedSec: 0,
    awayPendingSec: 0,
    awayRejectedSec: 0,
    awayUnexplainedSec: 0,
    unverifiedSec: 0,
    paidSec: 0,
    ...over,
  };
}

function report(name: string, email: string, days: PersonDaySummary[]): PersonMonthReport {
  return {
    person: {
      id: email,
      name,
      email,
      role: 'USER',
      department: 'Billing',
      designation: null,
      managerId: 'm1',
      managerName: 'Kavya Iyer',
    },
    month: '2026-09',
    locked: false,
    generatedAt: '2026-10-01T00:00:00.000Z',
    totals: {
      ...emptyTotals(),
      workdays: 2,
      full: 1,
      half: 1,
      focusSec: 12.5 * H,
      expectedSec: 16 * H,
      avgFocusSec: 6.25 * H,
      lateStarts: 1,
      skipped: 1,
      approvedPlusSec: 600,
      rejectedMinusSec: 900,
      pending: 2,
      quietHours: 3,
      targetSec: 15 * H,
      paidBreakSec: 90 * 60,
      unpaidBreakSec: 5 * 60,
      awayApprovedSec: 20 * 60,
      awayPendingSec: 10 * 60,
      paidSec: 14 * H,
      unverifiedSec: 30 * 60,
      adjustedSec: -20 * 60,
    },
    days,
    heatmap: [],
  };
}

async function readBack(buf: Buffer): Promise<Workbook> {
  const wb = new Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe('payrollWorkbook', () => {
  const people = [
    report('Asha Rao', 'asha@example.test', [
      daySummary({
        date: '2026-09-01',
        focusSec: 8.5 * H,
        startedAt: '2026-09-01T04:00:00.000Z',
        endedAt: '2026-09-01T13:05:00.000Z',
        breakSec: 45 * 60,
        paidBreakSec: 40 * 60,
        unpaidBreakSec: 5 * 60,
        awayApprovedSec: 20 * 60,
        awayPendingSec: 10 * 60 + 29,
        lateStart: { minutes: 0 },
        paidSec: 9 * H,
        unverifiedSec: 15 * 60,
        adjustedSec: 30 * 60,
      }),
      daySummary({
        date: '2026-09-02',
        weekday: 3,
        dayClass: 'HALF',
        focusSec: 4 * H,
        skipped: 1,
        adjustedSec: -50 * 60,
      }),
    ]),
    report('Ravi Shankar', 'ravi@example.test', [
      daySummary({ date: '2026-09-01', dayClass: 'ABSENT' }),
      daySummary({
        date: '2026-09-02',
        weekday: 3,
        workday: false,
        dayClass: 'OFF',
        label: 'Onam',
        targetSec: 0,
        expectedSec: 0,
      }),
    ]),
  ];

  it('has a Payroll sheet with one row per person, numbers as numbers', async () => {
    const wb = await readBack(await payrollWorkbook(people, TZ));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Payroll', 'Days']);
    const ws = wb.getWorksheet('Payroll')!;
    expect(ws.rowCount).toBe(3);
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual([
      'Name',
      'Email',
      'Department',
      'Manager',
      'Workdays',
      'Full days',
      'Half days',
      'Absent',
      'Extra days',
      'Focus hours',
      'Paid time',
      'Expected hours',
      'Avg focus per workday (h)',
      'Late starts',
      'Skipped',
      'Auto-skipped',
      'Overruns',
      'Approved min added',
      'Rejected min taken off',
      'Pending items',
      'Quiet hours',
      // 4.0 columns.
      'Target hours',
      'Paid break min',
      'Unpaid break min',
      'Away approved min',
      'Away pending min',
      'Offline, no activity data',
      // 3.3
      'Adjusted min (manual)',
      // 3.2
      'Active hours (keyboard/mouse)',
      'Late starts without a reason',
      'Leave days',
      'CL/SL days',
      'EL/PL days',
      'Paid leave hours',
      'Comp off days',
      'Comp off earned',
      'Remote days',
      'Remote hours over the cap',
      'No check-out days',
      // 3.6, at the end: every column before it stays where it was.
      'Meeting hours',
    ]);
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const asha = ws.getRow(2);
    expect(asha.getCell(1).value).toBe('Asha Rao');
    expect(asha.getCell(4).value).toBe('Kavya Iyer');
    expect(asha.getCell(10).value).toBe(12.5);
    expect(asha.getCell(11).value).toBe(14);
    expect(asha.getCell(11).numFmt).toBe('0.00');
    expect(asha.getCell(12).value).toBe(16);
    expect(asha.getCell(13).value).toBe(6.25);
    expect(asha.getCell(18).value).toBe(10);
    expect(asha.getCell(19).value).toBe(15);
    expect(asha.getCell(20).value).toBe(2);
    expect(asha.getCell(22).value).toBe(15);
    expect(asha.getCell(22).numFmt).toBe('0.00');
    expect(asha.getCell(23).value).toBe(90);
    expect(asha.getCell(24).value).toBe(5);
    expect(asha.getCell(25).value).toBe(20);
    expect(asha.getCell(26).value).toBe(10);
    expect(asha.getCell(27).value).toBe(0.5);
    // 3.3: minutes added by hand over the month, signed (already inside the focus hours).
    expect(asha.getCell(28).value).toBe(-20);
    expect(typeof asha.getCell(5).value).toBe('number');
    expect(asha.getCell(10).numFmt).toBe('0.00');
    expect(ws.getColumn(1).width).toBeGreaterThan(20);
  });

  it('has a Days sheet with one row per person and day, 12-hour times in the business zone', async () => {
    const wb = await readBack(await payrollWorkbook(people, TZ));
    const ws = wb.getWorksheet('Days')!;
    expect(ws.rowCount).toBe(5);
    expect((ws.getRow(1).values as unknown[]).slice(8, 10)).toEqual(['Focus hours', 'Paid time']);
    expect((ws.getRow(1).values as unknown[]).slice(22)).toEqual([
      'Holiday',
      'Target hours',
      'Paid break min',
      'Unpaid break min',
      'Away approved min',
      'Away pending min',
      'Offline, no activity data',
      'Adjusted min (manual)',
      // 3.2
      'Available min',
      'Late reason',
      // 3.4
      'Leave',
      'Leave days',
      'Paid leave hours',
      // 3.5
      'Remote (days)',
      'Remote hours counted',
      'Comp off earned',
      'No check-out',
    ]);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const first = ws.getRow(2);
    expect(first.getCell(3).value).toBe('2026-09-01');
    expect(first.getCell(4).value).toBe('Tue');
    expect(first.getCell(5).value).toBe('FULL');
    expect(first.getCell(6).value).toBe('9:30 AM');
    expect(first.getCell(7).value).toBe('6:35 PM');
    expect(first.getCell(8).value).toBe(8.5);
    expect(first.getCell(9).value).toBe(9);
    expect(first.getCell(11).value).toBe(45);
    expect(first.getCell(13).value).toBe(0);
    expect(ws.getRow(3).getCell(15).value).toBe(1);
    expect(ws.getRow(4).getCell(1).value).toBe('Ravi Shankar');
    expect(ws.getRow(4).getCell(6).value).toBe('');
    // 4.0 columns: holiday label, target, paid and unpaid breaks, away (minutes rounded),
    // offline time with no activity data (hours).
    expect(first.getCell(22).value).toBe('');
    expect(first.getCell(23).value).toBe(7.5);
    expect(first.getCell(24).value).toBe(40);
    expect(first.getCell(25).value).toBe(5);
    expect(first.getCell(26).value).toBe(20);
    expect(first.getCell(27).value).toBe(10);
    expect(first.getCell(28).value).toBe(0.25);
    // 3.3: signed minutes added by hand that day; none is 0.
    expect(first.getCell(29).value).toBe(30);
    expect(ws.getRow(3).getCell(29).value).toBe(-50);
    expect(ws.getRow(4).getCell(29).value).toBe(0);
    const holiday = ws.getRow(5);
    expect(holiday.getCell(5).value).toBe('OFF');
    expect(holiday.getCell(22).value).toBe('Onam');
    expect(holiday.getCell(23).value).toBe(0);
  });

  it('carries leave: the days per pool and the paid leave hours (3.4)', async () => {
    const leaveDay = daySummary({
      date: '2026-09-03',
      weekday: 4,
      dayClass: 'LEAVE',
      expectedSec: 0,
      leaveSec: 8 * H,
      leave: {
        days: 1,
        full: true,
        label: 'Full day',
        categories: 'CL/SL',
        clslDays: 1,
        elplDays: 0,
        compOffDays: 0,
        pendingDays: 0,
        mask: 15,
      },
    });
    const halfDay = daySummary({
      date: '2026-09-04',
      weekday: 5,
      dayClass: 'FULL',
      expectedSec: 4 * H,
      focusSec: 4 * H,
      leaveSec: 4 * H,
      leave: {
        days: 0.5,
        full: false,
        label: 'Half day (first half)',
        categories: 'EL/PL',
        clslDays: 0,
        elplDays: 0.5,
        compOffDays: 0,
        pendingDays: 0,
        mask: 3,
      },
    });
    const r = report('Lena Paul', 'lena@example.test', [leaveDay, halfDay]);
    r.totals = {
      ...r.totals,
      leave: 1,
      leaveDays: 1.5,
      clslDays: 1,
      elplDays: 0.5,
      compOffDays: 0,
      leaveSec: 12 * H,
    };
    const wb = await readBack(await payrollWorkbook([r], TZ));
    const payroll = wb.getWorksheet('Payroll')!;
    const ph = (payroll.getRow(1).values as unknown[]).slice(1);
    const at = (h: string) => ph.indexOf(h) + 1;
    expect(payroll.getRow(2).getCell(at('Leave days')).value).toBe(1.5);
    expect(payroll.getRow(2).getCell(at('CL/SL days')).value).toBe(1);
    expect(payroll.getRow(2).getCell(at('EL/PL days')).value).toBe(0.5);
    expect(payroll.getRow(2).getCell(at('Paid leave hours')).value).toBe(12);
    const days = wb.getWorksheet('Days')!;
    const dh = (days.getRow(1).values as unknown[]).slice(1);
    const col = (h: string) => dh.indexOf(h) + 1;
    expect(days.getRow(2).getCell(col('Day')).value).toBe('LEAVE');
    expect(days.getRow(2).getCell(col('Leave')).value).toBe('CL/SL full day');
    expect(days.getRow(3).getCell(col('Leave')).value).toBe('EL/PL half day (first half)');
    expect(days.getRow(3).getCell(col('Leave days')).value).toBe(0.5);
    expect(days.getRow(3).getCell(col('Paid leave hours')).value).toBe(4);
  });

  it('still makes both sheets for nobody', async () => {
    const wb = await readBack(await payrollWorkbook([], TZ));
    expect(wb.getWorksheet('Payroll')!.rowCount).toBe(1);
    expect(wb.getWorksheet('Days')!.rowCount).toBe(1);
  });
});

describe('timesheetWorkbook (4.0)', () => {
  const t: Timesheet = {
    person: {
      id: 'a',
      name: 'Asha Rao',
      email: 'asha@example.test',
      department: 'Billing',
      designation: null,
    },
    range: { from: '2026-09-14', to: '2026-09-15' },
    rows: [
      {
        date: '2026-09-14',
        weekday: 1,
        isWorkingDay: true,
        label: null,
        in: '2026-09-14T04:00:00.000Z',
        out: '2026-09-14T13:00:00.000Z',
        in12: '9:30 AM',
        out12: '6:30 PM',
        focusSec: 7.5 * H,
        targetSec: 7.5 * H,
        breakSec: 95 * 60,
        paidBreakSec: 90 * 60,
        unpaidBreakSec: 5 * 60,
        meetingsSec: 30 * 60,
        awayApprovedSec: 20 * 60,
        awayPendingSec: 0,
        unverifiedSec: 45 * 60,
        paidSec: 9 * H,
        adjustedSec: 15 * 60,
        status: 'FULL',
      },
      {
        date: '2026-09-15',
        weekday: 2,
        isWorkingDay: false,
        label: 'Holiday',
        in: null,
        out: null,
        in12: null,
        out12: null,
        focusSec: 0,
        targetSec: 0,
        breakSec: 0,
        paidBreakSec: 0,
        unpaidBreakSec: 0,
        meetingsSec: 0,
        awayApprovedSec: 0,
        awayPendingSec: 0,
        unverifiedSec: 0,
        paidSec: 0,
        adjustedSec: 0,
        status: 'OFF',
      },
    ],
    totals: {
      days: 2,
      workingDays: 1,
      full: 1,
      half: 0,
      absent: 0,
      focusSec: 7.5 * H,
      targetSec: 7.5 * H,
      breakSec: 95 * 60,
      paidBreakSec: 90 * 60,
      unpaidBreakSec: 5 * 60,
      meetingsSec: 30 * 60,
      awayApprovedSec: 20 * 60,
      awayPendingSec: 0,
      unverifiedSec: 45 * 60,
      paidSec: 9 * H,
      adjustedSec: 15 * 60,
    },
  };

  it('one Timesheet sheet: a row per day, 12-hour in and out, numbers as numbers, a bold total row', async () => {
    const wb = await readBack(await timesheetWorkbook(t));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Timesheet']);
    const ws = wb.getWorksheet('Timesheet')!;
    expect(ws.rowCount).toBe(4);
    expect((ws.getRow(1).values as unknown[]).slice(1)).toEqual([
      'Date',
      'Weekday',
      'Working day',
      'Holiday',
      'In',
      'Out',
      'Focus hours',
      'Paid time',
      'Target hours',
      'Break min',
      'Paid break min',
      'Unpaid break min',
      'Meeting min',
      'Away approved min',
      'Away pending min',
      'Offline, no activity data',
      'Day',
      'Adjusted min (manual)',
    ]);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect((ws.getRow(2).values as unknown[]).slice(1)).toEqual([
      '2026-09-14',
      'Mon',
      'Yes',
      '',
      '9:30 AM',
      '6:30 PM',
      7.5,
      9,
      7.5,
      95,
      90,
      5,
      30,
      20,
      0,
      0.75,
      'FULL',
      15,
    ]);
    expect(ws.getRow(3).getCell(3).value).toBe('No');
    expect(ws.getRow(3).getCell(4).value).toBe('Holiday');
    const total = ws.getRow(4);
    expect(total.getCell(1).value).toBe('Total');
    expect(total.getCell(7).value).toBe(7.5);
    expect(total.getCell(8).value).toBe(9);
    expect(total.getCell(16).value).toBe(0.75);
    expect(total.getCell(17).value).toBe('1 full, 0 half, 0 absent');
    expect(total.getCell(18).value).toBe(15);
    expect(total.font?.bold).toBe(true);
  });

  it('names the file after the person and the range', () => {
    expect(timesheetFileName('Asha Rao', '2026-09-01', '2026-09-30')).toBe(
      'rx-vision-timesheet-asha-rao-2026-09-01-to-2026-09-30.xlsx',
    );
    expect(timesheetFileName('  ', '2026-09-01', '2026-09-30')).toBe(
      'rx-vision-timesheet-person-2026-09-01-to-2026-09-30.xlsx',
    );
  });
});

describe('exportFileName', () => {
  it('names the file after the month and who it is for', () => {
    expect(exportFileName('2026-09', 'team')).toBe('rx-vision-2026-09-team.xlsx');
    expect(exportFileName('2026-09', 'Asha Rao')).toBe('rx-vision-2026-09-asha-rao.xlsx');
    expect(exportFileName('2026-09', "Zoë O'Brien-Núñez")).toBe(
      'rx-vision-2026-09-zoe-o-brien-nunez.xlsx',
    );
    expect(exportFileName('2026-09', '  ')).toBe('rx-vision-2026-09-person.xlsx');
    expect(exportFileName('2026-09', '"; rm -rf /')).toBe('rx-vision-2026-09-rm-rf.xlsx');
  });
});

describe('payrollWorkbook: the payroll pause (3.6)', () => {
  const agent = () => {
    const r = report('Asha Rao', 'asha@example.test', [
      daySummary({
        date: '2026-09-01',
        focusSec: 8 * H,
        meetingSec: 90 * 60,
        breakSec: 45 * 60,
        paidSec: 8.5 * H,
        paidBreakSec: 30 * 60,
      }),
    ]);
    r.totals.meetingSec = 90 * 60;
    return r;
  };
  const fullDay = (date: string) =>
    daySummary({ date, focusSec: 9 * H, startedAt: `${date}T04:00:00.000Z`, payrollPaused: true });
  const biometric = (days: PersonDaySummary[], paused: boolean): PersonMonthReport => ({
    ...report('Bala Krishnan', 'bala@example.test', days),
    payroll: {
      paused,
      label: 'Payroll paused · biometric integration pending',
      pausedDays: days.filter((d) => d.payrollPaused).length,
      pausedFrom: '2026-09-01',
      pausedTo: '2026-09-02',
      totals: {
        ...emptyTotals(),
        focusSec: paused ? 0 : 7 * H,
        paidSec: paused ? 0 : 7 * H,
      },
    },
  });
  /** Every row of a sheet, cell by cell. */
  const rows = (wb: Workbook, name: string) => {
    const out: unknown[][] = [];
    wb.getWorksheet(name)?.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
    return out;
  };

  it('nobody paused: no third sheet, and the Meeting column is the last one', async () => {
    const wb = await readBack(await payrollWorkbook([agent()], TZ));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Payroll', 'Days']);
    const header = rows(wb, 'Payroll')[0];
    expect(header[header.length - 1]).toBe('Meeting hours');
    expect(rows(wb, 'Payroll')[1][header.length - 1]).toBe(1.5);
  });

  it('a month stored before 3.6 reads its meeting hours from its days', async () => {
    const old = agent();
    delete (old.totals as { meetingSec?: number }).meetingSec;
    const wb = await readBack(await payrollWorkbook([old], TZ));
    const header = rows(wb, 'Payroll')[0];
    expect(rows(wb, 'Payroll')[1][header.length - 1]).toBe(1.5);
  });

  it('someone fully paused is on neither payroll sheet, only named on the third', async () => {
    const wb = await readBack(
      await payrollWorkbook(
        [agent(), biometric([fullDay('2026-09-01'), fullDay('2026-09-02')], true)],
        TZ,
      ),
    );
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Payroll', 'Days', 'Payroll paused']);
    expect(rows(wb, 'Payroll').map((r) => r[0])).toEqual(['Name', 'Asha Rao']);
    expect(rows(wb, 'Days').map((r) => r[0])).toEqual(['Name', 'Asha Rao']);
    expect(rows(wb, 'Payroll paused')).toEqual([
      ['Name', 'Email', 'Department', 'Manager', 'Payroll', 'Paused days', 'From', 'To'],
      [
        'Bala Krishnan',
        'bala@example.test',
        'Billing',
        'Kavya Iyer',
        'Payroll paused · biometric integration pending',
        2,
        '2026-09-01',
        '2026-09-02',
      ],
    ]);
  });

  it('someone partly paused: the calculated days go to payroll, and the rest are named', async () => {
    const counted = daySummary({ date: '2026-09-03', focusSec: 7 * H, paidSec: 7 * H });
    const wb = await readBack(
      await payrollWorkbook(
        [biometric([fullDay('2026-09-01'), fullDay('2026-09-02'), counted], false)],
        TZ,
      ),
    );
    const payroll = rows(wb, 'Payroll');
    expect(payroll.map((r) => r[0])).toEqual(['Name', 'Bala Krishnan']);
    // Focus hours and paid hours count only the day calculated.
    expect(payroll[1][payroll[0].indexOf('Focus hours')]).toBe(7);
    expect(payroll[1][payroll[0].indexOf('Paid time')]).toBe(7);
    expect(rows(wb, 'Days').map((r) => r[2])).toEqual(['Date', '2026-09-03']);
    expect(rows(wb, 'Payroll paused')[1][4]).toBe('Payroll paused · biometric integration pending');
  });

  it('a colleague being paused changes nothing for agent staff, cell by cell', async () => {
    const before = await readBack(await payrollWorkbook([agent()], TZ));
    const after = await readBack(
      await payrollWorkbook([biometric([fullDay('2026-09-01')], true), agent()], TZ),
    );
    expect(rows(after, 'Payroll')).toEqual(rows(before, 'Payroll'));
    expect(rows(after, 'Days')).toEqual(rows(before, 'Days'));
  });
});
