import { Workbook, Worksheet } from 'exceljs';
import { time12InZone } from '@shared/utils/timezone';
import { PersonDaySummary, PersonMonthReport } from '../domain/report.types';

/**
 * The payroll workbook (SPEC 3.7): sheet "Payroll" with one row per person and
 * sheet "Days" with one row per person and day. Frozen bold header, sensible
 * widths, every number a real number (hours as decimals with two places).
 */

const hours = (sec: number) => Math.round((sec / 3600) * 100) / 100;
/** 4.0: time in sessions opened by an offline replay that the agent's activity does not cover (hours). */
const UNVERIFIED_HEADER = 'Offline, no activity data';
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
  { header: 'Paid time', key: 'paidHours', width: 11, hours: true },
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
  { header: 'Target hours', key: 'targetHours', width: 13, hours: true },
  { header: 'Paid break min', key: 'paidBreakMin', width: 14 },
  { header: 'Unpaid break min', key: 'unpaidBreakMin', width: 16 },
  { header: 'Away approved min', key: 'awayApprovedMin', width: 17 },
  { header: 'Away pending min', key: 'awayPendingMin', width: 16 },
  { header: UNVERIFIED_HEADER, key: 'unverifiedHours', width: 24, hours: true },
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
  { header: 'Paid time', key: 'paidHours', width: 11, hours: true },
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
  { header: 'Holiday', key: 'label', width: 16 },
  { header: 'Target hours', key: 'targetHours', width: 13, hours: true },
  { header: 'Paid break min', key: 'paidBreakMin', width: 14 },
  { header: 'Unpaid break min', key: 'unpaidBreakMin', width: 16 },
  { header: 'Away approved min', key: 'awayApprovedMin', width: 17 },
  { header: 'Away pending min', key: 'awayPendingMin', width: 16 },
  { header: UNVERIFIED_HEADER, key: 'unverifiedHours', width: 24, hours: true },
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
    started: d.startedAt ? time12InZone(new Date(d.startedAt), tz) : '',
    ended: d.endedAt ? time12InZone(new Date(d.endedAt), tz) : '',
    focusHours: hours(d.focusSec),
    paidHours: hours(d.paidSec ?? d.focusSec + (d.paidBreakSec ?? 0)),
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
    label: d.label ?? '',
    targetHours: hours(d.targetSec ?? d.expectedSec),
    paidBreakMin: minutes(d.paidBreakSec ?? 0),
    unpaidBreakMin: minutes(d.unpaidBreakSec ?? 0),
    awayApprovedMin: minutes(d.awayApprovedSec ?? 0),
    awayPendingMin: minutes(d.awayPendingSec ?? 0),
    unverifiedHours: hours(d.unverifiedSec ?? 0),
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
      paidHours: hours(t.paidSec ?? t.focusSec + (t.paidBreakSec ?? 0)),
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
      targetHours: hours(t.targetSec ?? t.expectedSec),
      paidBreakMin: minutes(t.paidBreakSec ?? 0),
      unpaidBreakMin: minutes(t.unpaidBreakSec ?? 0),
      awayApprovedMin: minutes(t.awayApprovedSec ?? 0),
      awayPendingMin: minutes(t.awayPendingSec ?? 0),
      unverifiedHours: hours(t.unverifiedSec ?? 0),
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

/** 4.0 timesheet rows (GET /reports/person/:id/timesheet). */
export interface TimesheetRow {
  date: string;
  weekday: number;
  isWorkingDay: boolean;
  label: string | null;
  in: string | null;
  out: string | null;
  in12: string | null;
  out12: string | null;
  focusSec: number;
  targetSec: number;
  breakSec: number;
  paidBreakSec: number;
  unpaidBreakSec: number;
  meetingsSec: number;
  awayApprovedSec: number;
  awayPendingSec: number;
  /** Offline time with no activity data (not focus, not paid). */
  unverifiedSec: number;
  /** Payroll time: focusSec + paidBreakSec. */
  paidSec: number;
  status: string;
}

export interface Timesheet {
  person: {
    id: string;
    name: string;
    email: string;
    department: string | null;
    designation: string | null;
  };
  range: { from: string; to: string };
  rows: TimesheetRow[];
  totals: {
    days: number;
    workingDays: number;
    full: number;
    half: number;
    absent: number;
    focusSec: number;
    targetSec: number;
    breakSec: number;
    paidBreakSec: number;
    unpaidBreakSec: number;
    meetingsSec: number;
    awayApprovedSec: number;
    awayPendingSec: number;
    unverifiedSec: number;
    paidSec: number;
  };
}

const TIMESHEET: Col[] = [
  { header: 'Date', key: 'date', width: 12 },
  { header: 'Weekday', key: 'weekday', width: 9 },
  { header: 'Working day', key: 'working', width: 12 },
  { header: 'Holiday', key: 'label', width: 16 },
  { header: 'In', key: 'in', width: 10 },
  { header: 'Out', key: 'out', width: 10 },
  { header: 'Focus hours', key: 'focusHours', width: 12, hours: true },
  { header: 'Paid time', key: 'paidHours', width: 11, hours: true },
  { header: 'Target hours', key: 'targetHours', width: 13, hours: true },
  { header: 'Break min', key: 'breakMin', width: 10 },
  { header: 'Paid break min', key: 'paidBreakMin', width: 14 },
  { header: 'Unpaid break min', key: 'unpaidBreakMin', width: 16 },
  { header: 'Meeting min', key: 'meetingMin', width: 12 },
  { header: 'Away approved min', key: 'awayApprovedMin', width: 17 },
  { header: 'Away pending min', key: 'awayPendingMin', width: 16 },
  { header: UNVERIFIED_HEADER, key: 'unverifiedHours', width: 24, hours: true },
  { header: 'Day', key: 'status', width: 12 },
];

/** The timesheet as a one-sheet workbook ("Timesheet"), totals in the last row. */
export async function timesheetWorkbook(t: Timesheet): Promise<Buffer> {
  const wb = new Workbook();
  wb.creator = 'RX Vision';
  wb.created = new Date();
  const ws = sheet(wb, 'Timesheet', TIMESHEET);
  for (const r of t.rows) {
    ws.addRow({
      date: r.date,
      weekday: WEEKDAY[r.weekday] ?? '',
      working: r.isWorkingDay ? 'Yes' : 'No',
      label: r.label ?? '',
      in: r.in12 ?? '',
      out: r.out12 ?? '',
      focusHours: hours(r.focusSec),
      paidHours: hours(r.paidSec),
      targetHours: hours(r.targetSec),
      breakMin: minutes(r.breakSec),
      paidBreakMin: minutes(r.paidBreakSec),
      unpaidBreakMin: minutes(r.unpaidBreakSec),
      meetingMin: minutes(r.meetingsSec),
      awayApprovedMin: minutes(r.awayApprovedSec),
      awayPendingMin: minutes(r.awayPendingSec),
      unverifiedHours: hours(r.unverifiedSec),
      status: r.status,
    });
  }
  const total = ws.addRow({
    date: 'Total',
    focusHours: hours(t.totals.focusSec),
    paidHours: hours(t.totals.paidSec),
    targetHours: hours(t.totals.targetSec),
    breakMin: minutes(t.totals.breakSec),
    paidBreakMin: minutes(t.totals.paidBreakSec),
    unpaidBreakMin: minutes(t.totals.unpaidBreakSec),
    meetingMin: minutes(t.totals.meetingsSec),
    awayApprovedMin: minutes(t.totals.awayApprovedSec),
    awayPendingMin: minutes(t.totals.awayPendingSec),
    unverifiedHours: hours(t.totals.unverifiedSec),
    status: `${t.totals.full} full, ${t.totals.half} half, ${t.totals.absent} absent`,
  });
  total.font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** "rx-vision-timesheet-asha-rao-2026-09-01-to-2026-09-30.xlsx". */
export function timesheetFileName(name: string, from: string, to: string): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'person';
  return `rx-vision-timesheet-${slug}-${from}-to-${to}.xlsx`;
}
