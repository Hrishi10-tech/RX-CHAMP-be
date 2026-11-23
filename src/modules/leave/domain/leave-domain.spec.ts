import {
  alreadyStatus,
  daysOf,
  formatDays,
  FULL_MASK,
  kindLabel,
  leadingQuarters,
  maskOf,
  PART_MASK,
  STATUS_LABEL,
  trailingQuarters,
  unitsOfDays,
  unitsOfMask,
} from './leave.types';
import {
  applyPolicyPatch,
  carryCapUnits,
  DEFAULT_LEAVE_POLICY,
  LeavePolicy,
  policyFromStored,
  policyGrantUnits,
} from './leave-policy';
import { firstLeaveYear, grantFor, proratedUnits, spendableUnits, yearBalances } from './balance';
import {
  checkNote,
  checkRequest,
  datesOf,
  leaveDay,
  leaveSpan,
  overlapping,
  priceDays,
  spanDays,
} from './request-rules';
import { canDecide, routeFor, waitsOn } from './routing';
import { partClock, workingWindow } from './parts';
import {
  leaveAdjustedCopy,
  leaveDecidedCopy,
  leaveRequestedCopy,
  leaveUpdatedCopy,
} from './leave-copy';

const policy = (over: Partial<LeavePolicy> = {}): LeavePolicy => ({
  ...DEFAULT_LEAVE_POLICY,
  startedOn: '2026-11-04',
  ...over,
});

describe('quarter-day units', () => {
  it('masks and units', () => {
    expect(maskOf('FULL_DAY', null)).toBe(FULL_MASK);
    expect(maskOf('HALF_DAY', 'FIRST_HALF')).toBe(0b0011);
    expect(maskOf('HALF_DAY', 'SECOND_HALF')).toBe(0b1100);
    expect(maskOf('QUARTER_DAY', 'Q3')).toBe(0b0100);
    expect(unitsOfMask(FULL_MASK)).toBe(4);
    expect(unitsOfMask(PART_MASK.FIRST_HALF)).toBe(2);
    expect(unitsOfMask(PART_MASK.Q4)).toBe(1);
    expect(unitsOfMask(0)).toBe(0);
  });

  it('leading and trailing quarters', () => {
    expect(leadingQuarters(PART_MASK.FIRST_HALF)).toBe(2);
    expect(leadingQuarters(PART_MASK.Q1)).toBe(1);
    expect(leadingQuarters(PART_MASK.Q2)).toBe(0);
    expect(leadingQuarters(FULL_MASK)).toBe(4);
    expect(leadingQuarters(PART_MASK.Q1 | PART_MASK.Q2 | PART_MASK.Q4)).toBe(2);
    expect(trailingQuarters(PART_MASK.SECOND_HALF)).toBe(2);
    expect(trailingQuarters(PART_MASK.Q4)).toBe(1);
    expect(trailingQuarters(PART_MASK.Q3)).toBe(0);
  });

  it('days to units and back, quarter days only', () => {
    expect(unitsOfDays(1.5)).toBe(6);
    expect(unitsOfDays(0.25)).toBe(1);
    expect(unitsOfDays(-2)).toBe(-8);
    expect(unitsOfDays(0.3)).toBeNull();
    expect(unitsOfDays('1')).toBeNull();
    expect(unitsOfDays(Number.NaN)).toBeNull();
    expect(daysOf(10)).toBe(2.5);
  });

  it('formats days with a real minus sign', () => {
    expect(formatDays(4)).toBe('1 day');
    expect(formatDays(2)).toBe('0.5 day');
    expect(formatDays(1)).toBe('0.25 day');
    expect(formatDays(9)).toBe('2.25 days');
    expect(formatDays(0)).toBe('0 days');
    expect(formatDays(-6)).toBe('−1.5 days');
    expect(formatDays(8, { signed: true })).toBe('+2 days');
    expect(formatDays(48)).toBe('12 days');
  });

  it('labels a kind', () => {
    expect(kindLabel('FULL_DAY', null)).toBe('Full day');
    expect(kindLabel('HALF_DAY', 'SECOND_HALF')).toBe('Half day (second half)');
    expect(kindLabel('QUARTER_DAY', 'Q1')).toBe('Quarter day (1st quarter)');
  });
});

describe('leave policy', () => {
  it('defaults: 12 CL/SL that lapse, 12 EL/PL that carry, 5 days notice, manager approves', () => {
    const p = policyFromStored(null);
    expect(p).toMatchObject({
      enabled: true,
      clslDaysPerYear: 12,
      elplDaysPerYear: 12,
      elplCarryCapDays: null,
      elplNoticeDays: 5,
      clslBackdateDays: 7,
      approver: 'MANAGER',
      prorateJoiners: true,
      startedOn: null,
    });
    expect(policyGrantUnits(p, 'CLSL')).toBe(48);
    expect(carryCapUnits(p)).toBeNull();
    expect(carryCapUnits({ ...p, elplCarryCapDays: 30 })).toBe(120);
  });

  it('reads what is stored and drops what is unreadable', () => {
    const p = policyFromStored({
      clslDaysPerYear: 10.5,
      elplDaysPerYear: 'x',
      elplCarryCapDays: 30,
      elplNoticeDays: 10,
      clslBackdateDays: 999,
      approver: 'SUPER_MANAGER',
      startedOn: '2026-11-04',
      enabled: false,
    });
    expect(p.clslDaysPerYear).toBe(10.5);
    expect(p.elplDaysPerYear).toBe(12);
    expect(p.elplCarryCapDays).toBe(30);
    expect(p.elplNoticeDays).toBe(10);
    expect(p.clslBackdateDays).toBe(7);
    expect(p.approver).toBe('SUPER_MANAGER');
    expect(p.startedOn).toBe('2026-11-04');
    expect(p.enabled).toBe(false);
  });

  it('patches within bounds and reports what changed', () => {
    const r = applyPolicyPatch(
      policy(),
      { elplNoticeDays: 10, elplCarryCapDays: 30 },
      { mayRoute: false },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.elplNoticeDays).toBe(10);
      expect(r.changed).toEqual(['elplNoticeDays', 'elplCarryCapDays']);
    }
    const back = applyPolicyPatch(
      policy({ elplCarryCapDays: 30 }),
      { elplCarryCapDays: null },
      { mayRoute: true },
    );
    expect(back.ok && back.value.elplCarryCapDays).toBeNull();
  });

  it('refuses out of bounds, not quarter days, unknown keys, and routing by a Super Manager', () => {
    const bad = (patch: Record<string, unknown>, mayRoute = true) => {
      const r = applyPolicyPatch(policy(), patch, { mayRoute });
      return r.ok ? null : r.field;
    };
    expect(bad({ clslDaysPerYear: 61 })).toBe('clslDaysPerYear');
    expect(bad({ clslDaysPerYear: 12.3 })).toBe('clslDaysPerYear');
    expect(bad({ elplNoticeDays: 1.5 })).toBe('elplNoticeDays');
    expect(bad({ clslBackdateDays: -1 })).toBe('clslBackdateDays');
    expect(bad({ approver: 'USER' })).toBe('approver');
    expect(bad({ enabled: 'yes' })).toBe('enabled');
    expect(bad({ startedOn: '2020-01-01' })).toBe('startedOn');
    expect(bad({ approver: 'SUPER_ADMIN' }, false)).toBe('approver');
    // The same route sent back by a Super Manager is not a change.
    expect(bad({ approver: 'MANAGER' }, false)).toBeNull();
  });
});

describe('balances', () => {
  const acct = (year: number, over: Partial<Parameters<typeof yearBalances>[1][number]> = {}) => ({
    year,
    grantedUnits: 48,
    carryCapUnits: null,
    adjustedUnits: 0,
    takenUnits: 0,
    pendingUnits: 0,
    ...over,
  });

  it('EL/PL carries the whole balance over when there is no cap', () => {
    const b = yearBalances('ELPL', [acct(2026, { takenUnits: 8, adjustedUnits: -4 }), acct(2027)]);
    expect(b.get(2026)!.balanceUnits).toBe(36);
    expect(b.get(2027)).toMatchObject({
      carriedUnits: 36,
      lapsedUnits: 0,
      balanceUnits: 84,
      availableUnits: 84,
    });
  });

  it('EL/PL carries at most the cap of the new year; the rest lapses', () => {
    const b = yearBalances('ELPL', [
      acct(2026),
      acct(2027, { carryCapUnits: 20, pendingUnits: 4 }),
    ]);
    expect(b.get(2027)).toMatchObject({
      carriedUnits: 20,
      lapsedUnits: 28,
      balanceUnits: 68,
      availableUnits: 64,
    });
  });

  it('a debt carries in full', () => {
    const b = yearBalances('ELPL', [
      acct(2026, { adjustedUnits: -60 }),
      acct(2027, { carryCapUnits: 20 }),
    ]);
    expect(b.get(2026)!.balanceUnits).toBe(-12);
    expect(b.get(2027)).toMatchObject({ carriedUnits: -12, lapsedUnits: 0, balanceUnits: 36 });
  });

  it('CL/SL lapses every year', () => {
    const b = yearBalances('CLSL', [acct(2026, { takenUnits: 10 }), acct(2027)]);
    expect(b.get(2027)).toMatchObject({ carriedUnits: 0, lapsedUnits: 38, balanceUnits: 48 });
  });

  it('nothing carries across a missing year', () => {
    const b = yearBalances('ELPL', [acct(2026), acct(2028)]);
    expect(b.get(2028)!.carriedUnits).toBe(0);
  });

  it('a forecast carry is not spendable before the year starts', () => {
    const b = yearBalances('ELPL', [acct(2026), acct(2027, { takenUnits: 4 })]).get(2027)!;
    expect(b.availableUnits).toBe(92);
    expect(spendableUnits(b, false)).toBe(44);
    expect(spendableUnits(b, true)).toBe(92);
    const debt = yearBalances('ELPL', [acct(2026, { adjustedUnits: -52 }), acct(2027)]).get(2027)!;
    expect(spendableUnits(debt, false)).toBe(44);
  });

  it('prorates a joiner to the nearest half day', () => {
    expect(proratedUnits(48, '2027-01-01')).toBe(48);
    expect(proratedUnits(48, '2027-07-01')).toBe(24); // 184 of 365 days: 24.2 units
    expect(proratedUnits(48, '2027-12-31')).toBe(0);
    expect(proratedUnits(48, '2027-10-01')).toBe(12); // 92 days: 12.1 units
  });

  it('grants in full to people here at go-live, pro rata to later joiners of that year', () => {
    const base = { fullUnits: 48, startedOn: '2026-11-04', prorateJoiners: true };
    expect(grantFor({ ...base, year: 2026, joinDate: '2025-03-01' })).toEqual({
      grantedUnits: 48,
      prorated: false,
    });
    expect(grantFor({ ...base, year: 2026, joinDate: '2026-02-01' })).toEqual({
      grantedUnits: 48,
      prorated: false,
    });
    expect(grantFor({ ...base, year: 2026, joinDate: '2026-12-01' })).toEqual({
      grantedUnits: 4,
      prorated: true,
    });
    expect(grantFor({ ...base, year: 2027, joinDate: '2027-07-01' })).toEqual({
      grantedUnits: 24,
      prorated: true,
    });
    expect(grantFor({ ...base, year: 2028, joinDate: '2027-07-01' })).toEqual({
      grantedUnits: 48,
      prorated: false,
    });
    expect(
      grantFor({ ...base, prorateJoiners: false, year: 2027, joinDate: '2027-07-01' }).prorated,
    ).toBe(false);
    expect(firstLeaveYear('2025-03-01', '2026-11-04')).toBe(2026);
    expect(firstLeaveYear('2027-02-01', '2026-11-04')).toBe(2027);
  });
});

describe('request rules', () => {
  const today = '2026-11-04'; // a Wednesday
  const ok = (input: Record<string, unknown>, p = policy()) =>
    checkRequest(input as never, { today, policy: p });
  const base = { category: 'CLSL', kind: 'FULL_DAY', startDate: '2026-11-04', reason: 'Unwell' };

  it('day labels', () => {
    expect(leaveDay('2026-11-09')).toBe('Mon 9 Nov');
    expect(leaveSpan('2026-11-09', '2026-11-13')).toBe('Mon 9 to Fri 13 Nov');
    expect(leaveSpan('2026-11-30', '2026-12-02')).toBe('Mon 30 Nov to Wed 2 Dec');
    expect(spanDays('2026-11-09', '2026-11-13')).toBe(5);
    expect(datesOf('2026-11-30', '2026-12-02')).toEqual(['2026-11-30', '2026-12-01', '2026-12-02']);
  });

  it('CL/SL today is fine; a full day has no part', () => {
    const r = ok(base);
    expect(r.ok && r.value).toMatchObject({ endDate: '2026-11-04', year: 2026, part: null });
    expect(ok({ ...base, part: 'Q1' })).toMatchObject({ ok: false, field: 'part' });
  });

  it('a half or quarter day needs its part and is one day', () => {
    expect(ok({ ...base, kind: 'HALF_DAY' })).toMatchObject({ ok: false, field: 'part' });
    expect(ok({ ...base, kind: 'HALF_DAY', part: 'Q1' })).toMatchObject({
      ok: false,
      field: 'part',
    });
    expect(ok({ ...base, kind: 'QUARTER_DAY', part: 'Q2' }).ok).toBe(true);
    expect(
      ok({ ...base, kind: 'HALF_DAY', part: 'FIRST_HALF', endDate: '2026-11-05' }),
    ).toMatchObject({
      ok: false,
      field: 'endDate',
    });
  });

  it('ranges: in order, at most 31 days, inside one year', () => {
    expect(ok({ ...base, endDate: '2026-11-03' })).toMatchObject({ ok: false, field: 'endDate' });
    expect(ok({ ...base, endDate: '2026-12-05' })).toMatchObject({
      ok: false,
      code: 'RANGE_TOO_LONG',
    });
    expect(ok({ ...base, endDate: '2026-12-04' }).ok).toBe(true); // 31 days exactly
    expect(ok({ ...base, startDate: '2026-12-28', endDate: '2027-01-02' })).toMatchObject({
      code: 'CROSSES_YEAR',
    });
    expect(ok({ ...base, startDate: '2028-01-03' })).toMatchObject({ code: 'TOO_FAR_AHEAD' });
    expect(ok({ ...base, startDate: '2027-01-04' }).ok).toBe(true);
  });

  it('EL/PL needs the notice; CL/SL can go back the backdating window', () => {
    const el = { ...base, category: 'ELPL' };
    expect(ok({ ...el, startDate: '2026-11-08' })).toMatchObject({ code: 'NOTICE_TOO_SHORT' });
    expect(ok({ ...el, startDate: '2026-11-09' }).ok).toBe(true);
    expect(ok({ ...el, startDate: '2026-11-04' }, policy({ elplNoticeDays: 0 })).ok).toBe(true);
    expect(ok({ ...base, startDate: '2026-10-28' }).ok).toBe(true);
    expect(ok({ ...base, startDate: '2026-10-27' })).toMatchObject({ code: 'TOO_FAR_BACK' });
    expect(ok({ ...base, startDate: '2026-11-03' }, policy({ clslBackdateDays: 0 }))).toMatchObject(
      {
        code: 'TOO_FAR_BACK',
      },
    );
    const msg = ok({ ...el, startDate: '2026-11-08' });
    expect(!msg.ok && msg.message).toContain('Mon 9 Nov');
  });

  it('nothing before leave went live', () => {
    expect(
      ok(
        { ...base, startDate: '2025-12-31' },
        policy({ clslBackdateDays: 62, startedOn: '2026-01-05' }),
      ),
    ).toMatchObject({
      code: 'BEFORE_LEAVE_STARTED',
    });
  });

  it('nothing before the person joined', () => {
    const r = checkRequest({ ...base, startDate: '2026-11-02' } as never, {
      today,
      policy: policy(),
      joinDate: '2026-11-03',
    });
    expect(r).toMatchObject({ ok: false, code: 'BEFORE_JOINING' });
    expect(!r.ok && r.message).toContain('Tue 3 Nov');
    expect(
      checkRequest({ ...base, startDate: '2026-11-03' } as never, {
        today,
        policy: policy(),
        joinDate: '2026-11-03',
      }).ok,
    ).toBe(true);
  });

  it('a reason of 3 to 300 characters, spaces tidied', () => {
    expect(ok({ ...base, reason: '  ' })).toMatchObject({ field: 'reason' });
    expect(ok({ ...base, reason: 'x'.repeat(301) })).toMatchObject({ field: 'reason' });
    const r = ok({ ...base, reason: '  Family   function ' });
    expect(r.ok && r.value.reason).toBe('Family function');
  });

  it('notes: optional to approve, required to reject', () => {
    expect(checkNote(undefined, false)).toEqual({ ok: true, note: null });
    expect(checkNote('', true).ok).toBe(false);
    expect(checkNote('ok', true).ok).toBe(false);
    expect(checkNote(' Enjoy ', false)).toEqual({ ok: true, note: 'Enjoy' });
  });

  it('charges working days only, and finds overlaps by quarter', () => {
    const priced = priceDays('FULL_DAY', null, [
      { date: '2026-11-13', workday: true, offLabel: null },
      { date: '2026-11-14', workday: false, offLabel: 'Weekly day off' },
      { date: '2026-11-16', workday: true, offLabel: null },
    ]);
    expect(priced.charged.map((d) => d.date)).toEqual(['2026-11-13', '2026-11-16']);
    expect(priced.skipped).toEqual([{ date: '2026-11-14', why: 'Weekly day off' }]);
    const held = [{ date: '2026-11-13', mask: PART_MASK.FIRST_HALF }];
    expect(overlapping([{ date: '2026-11-13', mask: PART_MASK.SECOND_HALF }], held)).toEqual([]);
    expect(overlapping([{ date: '2026-11-13', mask: PART_MASK.Q2 }], held)).toEqual(['2026-11-13']);
    expect(overlapping(priced.charged, held)).toEqual(['2026-11-13']);
  });
});

describe('routing (4.0: departments and the organisation admin)', () => {
  const people = {
    departmentManagerIds: ['m1', 'm2'],
    adminIds: ['a1'],
    superManagerIds: ['sm'],
    superAdminIds: ['sa1', 'sa2'],
  };
  const staff = { id: 'u1', role: 'USER', companyId: 'c1', departmentId: 'd1' };
  const manager = { id: 'm1', role: 'MANAGER', companyId: 'c1', departmentId: null };

  it("Staff go to their department's managers; the policy can send them to the Super Manager or the Admin", () => {
    expect(routeFor('MANAGER', staff, people)).toEqual({
      approverRole: 'MANAGER',
      approverId: null,
      notify: ['m1', 'm2'],
    });
    expect(routeFor('SUPER_MANAGER', staff, people)).toMatchObject({
      approverRole: 'SUPER_MANAGER',
      notify: ['sm'],
    });
    expect(routeFor('SUPER_ADMIN', staff, people)).toMatchObject({
      approverRole: 'ADMIN',
      notify: ['a1'],
    });
  });

  it('a department with no manager, Staff with no department and Managers go to the Admin', () => {
    const none = { ...people, departmentManagerIds: [] };
    expect(routeFor('MANAGER', staff, none)).toMatchObject({ approverRole: 'ADMIN' });
    expect(routeFor('MANAGER', { ...staff, departmentId: null }, people)).toMatchObject({
      approverRole: 'ADMIN',
    });
    expect(routeFor('MANAGER', manager, people)).toMatchObject({ approverRole: 'ADMIN' });
  });

  it("an Admin's leave goes to the Super Admins; with nobody left it is approved at once", () => {
    const admin = { id: 'a1', role: 'ADMIN', companyId: 'c1', departmentId: null };
    expect(routeFor('MANAGER', admin, people)).toMatchObject({
      approverRole: 'SUPER_ADMIN',
      notify: ['sa1', 'sa2'],
    });
    const lone = { id: 'sa1', role: 'SUPER_ADMIN', companyId: null, departmentId: null };
    expect(routeFor('MANAGER', lone, { ...people, superAdminIds: ['sa1'] })).toEqual({
      approverRole: null,
      approverId: null,
      notify: [],
    });
    // No Admin in the organisation: the Super Admins.
    expect(routeFor('SUPER_ADMIN', staff, { ...people, adminIds: [] })).toMatchObject({
      approverRole: 'SUPER_ADMIN',
    });
  });

  it('who may decide', () => {
    const onManager = { userId: 'u1', approverRole: 'MANAGER' as const };
    const mgrOf = (depts: string[]) => ({ id: 'm1', role: 'MANAGER', managedDepartmentIds: depts });
    const target = { role: 'USER', departmentId: 'd1' };
    expect(canDecide(mgrOf(['d1']), onManager, target)).toBe(true);
    expect(canDecide(mgrOf(['d2']), onManager, target)).toBe(false);
    expect(canDecide(mgrOf(['d1']), { ...onManager, approverRole: 'ADMIN' }, target)).toBe(false);
    expect(canDecide({ id: 'a1', role: 'ADMIN' }, onManager, target)).toBe(true);
    expect(canDecide({ id: 'sm', role: 'SUPER_MANAGER' }, onManager, target)).toBe(true);
    expect(
      canDecide(
        { id: 'sm', role: 'SUPER_MANAGER' },
        { ...onManager, approverRole: 'ADMIN' },
        target,
      ),
    ).toBe(false);
    // Nobody decides their own; an Admin never another Admin's.
    expect(canDecide({ id: 'u1', role: 'ADMIN' }, onManager, target)).toBe(false);
    expect(
      canDecide({ id: 'a2', role: 'ADMIN' }, onManager, { role: 'ADMIN', departmentId: null }),
    ).toBe(false);
    expect(canDecide({ id: 'u2', role: 'USER' }, onManager, target)).toBe(false);
  });

  it('what waits on whom', () => {
    const req = { userId: 'u1', approverRole: 'MANAGER' as const };
    const t = { role: 'USER', departmentId: 'd1', departmentHasManager: true };
    const mgr = { id: 'm1', role: 'MANAGER', managedDepartmentIds: ['d1'] };
    expect(waitsOn(mgr, req, t)).toBe(true);
    expect(waitsOn({ id: 'a1', role: 'ADMIN' }, req, t)).toBe(false);
    // A department left without a manager falls to the Admin.
    expect(waitsOn({ id: 'a1', role: 'ADMIN' }, req, { ...t, departmentHasManager: false })).toBe(
      true,
    );
    expect(waitsOn({ id: 'a1', role: 'ADMIN' }, { ...req, approverRole: 'ADMIN' }, t)).toBe(true);
    expect(waitsOn({ id: 'sm', role: 'SUPER_MANAGER' }, req, t)).toBe(false);
  });
});

describe('parts of the day', () => {
  it('clock times of a part on the shift', () => {
    expect(partClock('09:30', '18:30', PART_MASK.FIRST_HALF)).toBe('09:30 to 14:00');
    expect(partClock('09:30', '18:30', PART_MASK.Q2)).toBe('11:45 to 14:00');
    expect(partClock('22:00', '06:00', PART_MASK.SECOND_HALF)).toBe('02:00 to 06:00');
    expect(partClock('09:30', '18:30', FULL_MASK)).toBeNull();
    expect(partClock(null, '18:30', PART_MASK.Q1)).toBeNull();
  });

  it('the working window left on a part-leave day', () => {
    const s = new Date('2026-11-09T04:00:00Z');
    const e = new Date('2026-11-09T13:00:00Z');
    const first = workingWindow(s, e, PART_MASK.FIRST_HALF);
    expect(first.start.toISOString()).toBe('2026-11-09T08:30:00.000Z');
    expect(first.end.toISOString()).toBe('2026-11-09T13:00:00.000Z');
    const last = workingWindow(s, e, PART_MASK.Q4);
    expect(last.start.toISOString()).toBe('2026-11-09T04:00:00.000Z');
    expect(last.end.toISOString()).toBe('2026-11-09T10:45:00.000Z');
    expect(workingWindow(s, e, PART_MASK.Q2).start.toISOString()).toBe('2026-11-09T04:00:00.000Z');
  });
});

describe('a request no longer open, as the person reads it', () => {
  it('C-943: a rejected request is "Not approved", as its notice says', () => {
    expect(STATUS_LABEL.REJECTED).toBe('Not approved');
  });

  it.each([
    ['REJECTED', 'This request was not approved.'],
    ['APPROVED', 'This request is already approved.'],
    ['CANCELLED', 'This request is already cancelled.'],
    ['REVOKED', 'This request is already revoked.'],
  ] as const)('C-800, C-944: %s', (status, sentence) => {
    expect(`This request ${alreadyStatus(status)}.`).toBe(sentence);
  });
});

describe('notice copy', () => {
  const request = {
    category: 'CLSL' as const,
    startDate: '2026-11-09',
    endDate: '2026-11-09',
    units: 2,
    kindLabel: 'Half day (first half)',
    reason: 'Doctor appointment',
  };

  it('requested, decided, adjusted, updated', () => {
    expect(leaveRequestedCopy({ name: 'Asha Rao', request })).toEqual({
      title: 'Leave request: Asha Rao, Mon 9 Nov',
      body: 'CL/SL, half day, first half. Reason: Doctor appointment. Decide it in RX Vision, Leave.',
    });
    const ok = leaveDecidedCopy({
      request,
      approved: true,
      byName: 'Bala K',
      note: null,
      availableUnits: 42,
    });
    expect(ok.title).toBe('Leave approved: Mon 9 Nov');
    expect(ok.body).toContain('You have 10.5 days of CL/SL left.');
    const no = leaveDecidedCopy({
      request,
      approved: false,
      byName: 'Bala K',
      note: 'Release week',
      availableUnits: 44,
    });
    expect(no.title).toBe('Leave not approved: Mon 9 Nov');
    expect(no.body).toContain('not approved by Bala K: Release week.');
    const adj = leaveAdjustedCopy({
      category: 'ELPL',
      year: 2026,
      mode: 'SUBTRACT',
      deltaUnits: -6,
      targetUnits: null,
      byName: 'Sara M',
      reason: 'Taken before RX Vision',
      balanceUnits: 42,
    });
    expect(adj.title).toBe('Leave balance changed: −1.5 days EL/PL');
    expect(adj.body).toContain('took off 1.5 days from your EL/PL for 2026');
    const upd = leaveUpdatedCopy({
      request: { ...request, units: 4, kindLabel: 'Full day' },
      givenBack: [{ date: '2026-11-09', why: 'Diwali' }],
      cancelled: true,
    });
    expect(upd.title).toBe('Leave no longer needed: Mon 9 Nov');
    expect(upd.body).toContain('Mon 9 Nov (Diwali) is no longer a working day');
  });
});
