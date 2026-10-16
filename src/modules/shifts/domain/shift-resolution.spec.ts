import { resolveShift } from './shift-resolution';
import { ShiftAssignmentRecord, ShiftRecord } from './shift.types';

function shift(id: string, companyId: string | null = 'co-1', isDefault = false): ShiftRecord {
  return {
    id,
    companyId,
    isDefault,
    name: id,
    start: '09:30',
    end: '18:30',
    workDays: [1, 2, 3, 4, 5, 6],
    ringLeadMin: 1,
    ringDurationMin: 5,
    ringSound: true,
    reasonOnEarly: true,
    reasonOnLate: true,
    reasonMinChars: 10,
    overrunReason: false,
    overrunGraceMin: 2,
    breaks: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

let seq = 0;
function row(over: Partial<ShiftAssignmentRecord>): ShiftAssignmentRecord {
  seq += 1;
  return {
    id: `a-${seq}`,
    target: 'USER',
    companyId: 'co-1',
    department: null,
    departmentKey: null,
    userId: null,
    shiftId: null,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    createdById: null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    ...over,
  };
}

const general = shift('general', 'co-1', true);
const early = shift('early');
const night = shift('night');
const globalDefault = shift('global', null, true);
const byId = new Map([general, early, night, globalDefault].map((s) => [s.id, s]));
const person = { id: 'u-1', companyId: 'co-1', department: '  Customer   Support ' };
const DAY = '2026-10-13';

describe('resolveShift', () => {
  it('falls back to the company default', () => {
    const r = resolveShift(person, DAY, [], byId, [general, globalDefault]);
    expect(r).toMatchObject({ shift: general, source: 'DEFAULT', assignment: null });
  });

  it('uses the company-less default for someone with no company default', () => {
    const r = resolveShift({ ...person, companyId: 'co-2' }, DAY, [], byId, [
      general,
      globalDefault,
    ]);
    expect(r.shift).toBe(globalDefault);
  });

  it('reports NONE when nothing applies', () => {
    expect(resolveShift(person, DAY, [], byId, []).source).toBe('NONE');
  });

  it('matches departments ignoring case and spacing', () => {
    const dept = row({
      target: 'DEPARTMENT',
      department: 'customer support',
      departmentKey: 'customer support',
      shiftId: 'early',
    });
    expect(resolveShift(person, DAY, [dept], byId, [general])).toMatchObject({
      shift: early,
      source: 'DEPARTMENT',
    });
  });

  it('prefers a personal override to the department shift', () => {
    const dept = row({ target: 'DEPARTMENT', departmentKey: 'customer support', shiftId: 'early' });
    const mine = row({ userId: 'u-1', shiftId: 'night' });
    expect(resolveShift(person, DAY, [dept, mine], byId, [general])).toMatchObject({
      shift: night,
      source: 'OVERRIDE',
    });
  });

  it('treats an override with no shift as "back to the department"', () => {
    const dept = row({ target: 'DEPARTMENT', departmentKey: 'customer support', shiftId: 'early' });
    const old = row({ userId: 'u-1', shiftId: 'night', effectiveFrom: '2026-09-01' });
    const reset = row({ userId: 'u-1', shiftId: null, effectiveFrom: '2026-10-01' });
    expect(resolveShift(person, DAY, [dept, old, reset], byId, [general]).shift).toBe(early);
  });

  it('ignores rows that start later or have ended', () => {
    const future = row({ userId: 'u-1', shiftId: 'night', effectiveFrom: '2026-10-14' });
    const ended = row({
      userId: 'u-1',
      shiftId: 'early',
      effectiveFrom: '2026-10-01',
      effectiveTo: '2026-10-12',
    });
    expect(resolveShift(person, DAY, [future, ended], byId, [general]).source).toBe('DEFAULT');
  });

  it('lets a temporary override end and the earlier one resume', () => {
    const base = row({ userId: 'u-1', shiftId: 'night', effectiveFrom: '2026-09-01' });
    const temp = row({
      userId: 'u-1',
      shiftId: 'early',
      effectiveFrom: '2026-10-10',
      effectiveTo: '2026-10-12',
    });
    expect(resolveShift(person, '2026-10-11', [base, temp], byId, [general]).shift).toBe(early);
    expect(resolveShift(person, DAY, [base, temp], byId, [general]).shift).toBe(night);
  });

  it('picks the newest of two rows from the same day', () => {
    const first = row({ userId: 'u-1', shiftId: 'early', effectiveFrom: DAY });
    const second = row({ userId: 'u-1', shiftId: 'night', effectiveFrom: DAY });
    expect(resolveShift(person, DAY, [second, first], byId, [general]).shift).toBe(night);
  });

  it("prefers the person's company row over an all-companies row for the department", () => {
    const all = row({
      target: 'DEPARTMENT',
      companyId: null,
      departmentKey: 'customer support',
      shiftId: 'night',
      effectiveFrom: '2026-10-01',
    });
    const ours = row({
      target: 'DEPARTMENT',
      companyId: 'co-1',
      departmentKey: 'customer support',
      shiftId: 'early',
      effectiveFrom: '2026-09-01',
    });
    expect(resolveShift(person, DAY, [all, ours], byId, [general]).shift).toBe(early);
  });

  it("does not apply another company's department row", () => {
    const theirs = row({
      target: 'DEPARTMENT',
      companyId: 'co-2',
      departmentKey: 'customer support',
      shiftId: 'early',
    });
    expect(resolveShift(person, DAY, [theirs], byId, [general]).source).toBe('DEFAULT');
  });

  it('falls through when the assigned shift was deleted', () => {
    const gone = row({ userId: 'u-1', shiftId: 'deleted-shift' });
    expect(resolveShift(person, DAY, [gone], byId, [general]).shift).toBe(general);
  });
});
