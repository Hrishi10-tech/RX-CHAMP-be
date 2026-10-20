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
      }),
      daySummary({ date: '2026-09-02', weekday: 3, dayClass: 'HALF', focusSec: 4 * H, skipped: 1 }),
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
    const holiday = ws.getRow(5);
    expect(holiday.getCell(5).value).toBe('OFF');
    expect(holiday.getCell(22).value).toBe('Onam');
    expect(holiday.getCell(23).value).toBe(0);
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
    ]);
    expect(ws.getRow(3).getCell(3).value).toBe('No');
    expect(ws.getRow(3).getCell(4).value).toBe('Holiday');
    const total = ws.getRow(4);
    expect(total.getCell(1).value).toBe('Total');
    expect(total.getCell(7).value).toBe(7.5);
    expect(total.getCell(8).value).toBe(9);
    expect(total.getCell(16).value).toBe(0.75);
    expect(total.getCell(17).value).toBe('1 full, 0 half, 0 absent');
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
