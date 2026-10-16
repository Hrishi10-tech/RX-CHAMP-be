import { Workbook } from 'exceljs';
import { emptyTotals } from '../domain/report-builder';
import { PersonDaySummary, PersonMonthReport } from '../domain/report.types';
import { exportFileName, payrollWorkbook } from './report-export';

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
        lateStart: { minutes: 0 },
      }),
      daySummary({ date: '2026-09-02', weekday: 3, dayClass: 'HALF', focusSec: 4 * H, skipped: 1 }),
    ]),
    report('Ravi Shankar', 'ravi@example.test', [
      daySummary({ date: '2026-09-01', dayClass: 'ABSENT' }),
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
    ]);
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const asha = ws.getRow(2);
    expect(asha.getCell(1).value).toBe('Asha Rao');
    expect(asha.getCell(4).value).toBe('Kavya Iyer');
    expect(asha.getCell(10).value).toBe(12.5);
    expect(asha.getCell(11).value).toBe(16);
    expect(asha.getCell(12).value).toBe(6.25);
    expect(asha.getCell(17).value).toBe(10);
    expect(asha.getCell(18).value).toBe(15);
    expect(asha.getCell(19).value).toBe(2);
    expect(typeof asha.getCell(5).value).toBe('number');
    expect(asha.getCell(10).numFmt).toBe('0.00');
    expect(ws.getColumn(1).width).toBeGreaterThan(20);
  });

  it('has a Days sheet with one row per person and day, times in the business zone', async () => {
    const wb = await readBack(await payrollWorkbook(people, TZ));
    const ws = wb.getWorksheet('Days')!;
    expect(ws.rowCount).toBe(4);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const first = ws.getRow(2);
    expect(first.getCell(3).value).toBe('2026-09-01');
    expect(first.getCell(4).value).toBe('Tue');
    expect(first.getCell(5).value).toBe('FULL');
    expect(first.getCell(6).value).toBe('09:30');
    expect(first.getCell(7).value).toBe('18:35');
    expect(first.getCell(8).value).toBe(8.5);
    expect(first.getCell(10).value).toBe(45);
    expect(first.getCell(12).value).toBe(0);
    expect(ws.getRow(3).getCell(14).value).toBe(1);
    expect(ws.getRow(4).getCell(1).value).toBe('Ravi Shankar');
    expect(ws.getRow(4).getCell(6).value).toBe('');
  });

  it('still makes both sheets for nobody', async () => {
    const wb = await readBack(await payrollWorkbook([], TZ));
    expect(wb.getWorksheet('Payroll')!.rowCount).toBe(1);
    expect(wb.getWorksheet('Days')!.rowCount).toBe(1);
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
