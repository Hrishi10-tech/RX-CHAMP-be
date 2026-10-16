import { Workbook, Worksheet } from 'exceljs';
import { hmInZone } from '@shared/utils/timezone';
import { PersonDaySummary, PersonMonthReport } from '../domain/report.types';

/**
 * The payroll workbook (SPEC 3.7): sheet "Payroll" with one row per person and
 * sheet "Days" with one row per person and day. Frozen bold header, sensible
 * widths, every number a real number (hours as decimals with two places).
 */

const hours = (sec: number) => Math.round((sec / 3600) * 100) / 100;
const minutes = (sec: number) => Math.round(sec / 60);
const WEEKDAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

interface Col {
  header: string;
  key: string;
  width: number;
  hours?: boolean;
}

const PAYROLL: Col[] = [
  { header: 'Name', key: 'name', width: 26 },
  { header: 'Email', key: 'email', width: 30 },
  { header: 'Department', key: 'department', width: 16 },
  { header: 'Manager', key: 'manager', width: 22 },
  { header: 'Workdays', key: 'workdays', width: 10 },
  { header: 'Full days', key: 'full', width: 10 },
  { header: 'Half days', key: 'half', width: 10 },
  { header: 'Absent', key: 'absent', width: 9 },
  { header: 'Extra days', key: 'extra', width: 10 },
  { header: 'Focus hours', key: 'focusHours', width: 12, hours: true },
  { header: 'Expected hours', key: 'expectedHours', width: 14, hours: true },
  { header: 'Avg focus per workday (h)', key: 'avgFocusHours', width: 22, hours: true },
  { header: 'Late starts', key: 'lateStarts', width: 11 },
  { header: 'Skipped', key: 'skipped', width: 9 },
  { header: 'Auto-skipped', key: 'autoSkipped', width: 12 },
  { header: 'Overruns', key: 'overruns', width: 10 },
  { header: 'Approved min added', key: 'approvedMin', width: 18 },
  { header: 'Rejected min taken off', key: 'rejectedMin', width: 20 },
  { header: 'Pending items', key: 'pending', width: 13 },
  { header: 'Quiet hours', key: 'quietHours', width: 11 },
];

const DAYS: Col[] = [
  { header: 'Name', key: 'name', width: 26 },
  { header: 'Email', key: 'email', width: 30 },
  { header: 'Date', key: 'date', width: 12 },
  { header: 'Weekday', key: 'weekday', width: 9 },
  { header: 'Day', key: 'dayClass', width: 12 },
  { header: 'Started', key: 'started', width: 9 },
  { header: 'Ended', key: 'ended', width: 9 },
  { header: 'Focus hours', key: 'focusHours', width: 12, hours: true },
  { header: 'Expected hours', key: 'expectedHours', width: 14, hours: true },
  { header: 'Break min', key: 'breakMin', width: 10 },
  { header: 'Meeting min', key: 'meetingMin', width: 12 },
  { header: 'Late start min', key: 'lateMin', width: 13 },
  { header: 'Breaks taken', key: 'breaksTaken', width: 12 },
  { header: 'Skipped', key: 'skipped', width: 9 },
  { header: 'Auto-skipped', key: 'autoSkipped', width: 12 },
  { header: 'Overruns', key: 'overruns', width: 10 },
  { header: 'Meetings', key: 'meetings', width: 10 },
  { header: 'Pending', key: 'pending', width: 9 },
  { header: 'Quiet hours', key: 'quietHours', width: 11 },
  { header: 'Active min', key: 'activeMin', width: 11 },
];

function sheet(wb: Workbook, name: string, cols: Col[]): Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  for (const c of cols) if (c.hours) ws.getColumn(c.key).numFmt = '0.00';
  return ws;
}

function dayRow(p: PersonMonthReport, d: PersonDaySummary, tz: string) {
  return {
    name: p.person.name,
    email: p.person.email,
    date: d.date,
    weekday: WEEKDAY[d.weekday] ?? '',
    dayClass: d.dayClass,
    started: d.startedAt ? hmInZone(new Date(d.startedAt), tz) : '',
    ended: d.endedAt ? hmInZone(new Date(d.endedAt), tz) : '',
    focusHours: hours(d.focusSec),
    expectedHours: hours(d.expectedSec),
    breakMin: minutes(d.breakSec),
    meetingMin: minutes(d.meetingSec),
    lateMin: d.lateStart?.minutes ?? 0,
    breaksTaken: d.breaksTaken,
    skipped: d.skipped,
    autoSkipped: d.autoSkipped,
    overruns: d.overruns,
    meetings: d.meetings,
    pending: d.pending,
    quietHours: d.quietHours,
    activeMin: d.activeMin,
  };
}

/** The workbook for these people's months, as an .xlsx buffer. */
export async function payrollWorkbook(persons: PersonMonthReport[], tz: string): Promise<Buffer> {
  const wb = new Workbook();
  wb.creator = 'RX Vision';
  wb.created = new Date();
  const payroll = sheet(wb, 'Payroll', PAYROLL);
  const days = sheet(wb, 'Days', DAYS);
  for (const p of persons) {
    const t = p.totals;
    payroll.addRow({
      name: p.person.name,
      email: p.person.email,
      department: p.person.department ?? '',
      manager: p.person.managerName ?? '',
      workdays: t.workdays,
      full: t.full,
      half: t.half,
      absent: t.absent,
      extra: t.extra,
      focusHours: hours(t.focusSec),
      expectedHours: hours(t.expectedSec),
      avgFocusHours: hours(t.avgFocusSec),
      lateStarts: t.lateStarts,
      skipped: t.skipped,
      autoSkipped: t.autoSkipped,
      overruns: t.overruns,
      approvedMin: minutes(t.approvedPlusSec),
      rejectedMin: minutes(t.rejectedMinusSec),
      pending: t.pending,
      quietHours: t.quietHours,
    });
    for (const d of p.days) days.addRow(dayRow(p, d, tz));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** "rx-vision-2026-09-team.xlsx", "rx-vision-2026-09-asha-rao.xlsx". */
export function exportFileName(month: string, who: string): string {
  const slug =
    who
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'person';
  return `rx-vision-${month}-${slug}.xlsx`;
}
