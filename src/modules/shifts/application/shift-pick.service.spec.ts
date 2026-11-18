import { NewAssignment } from '../domain/shift.repository';
import { ShiftAssignmentRecord, ShiftRecord } from '../domain/shift.types';
import { BreakDayService } from './break-day.service';
import { ShiftPickService } from './shift-pick.service';

jest.mock('@shared/utils/timezone', () => ({
  ...jest.requireActual('@shared/utils/timezone'),
  appTimezone: () => 'Asia/Kolkata',
}));

const CO = 'co-1';
const at = (hm: string) => new Date(`2026-11-17T${hm}:00+05:30`);

function shift(id: string, start: string, end: string): ShiftRecord {
  return {
    id,
    companyId: CO,
    isDefault: false,
    name: id,
    start,
    end,
    workDays: [1, 2, 3, 4, 5, 6, 7],
    ringLeadMin: 1,
    ringDurationMin: 5,
    ringSound: true,
    reasonOnEarly: true,
    reasonOnLate: true,
    reasonMinChars: 10,
    overrunReason: false,
    overrunGraceMin: 3,
    breaks: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

function setup(opts: { extras?: string[]; personal?: string; shared?: boolean } = {}) {
  const day = shift('day', '06:00', '15:00');
  const eve = shift('eve', '17:00', '22:00');
  const own = shift('own', '10:00', '19:00');
  let seq = 0;
  const row = (r: NewAssignment): ShiftAssignmentRecord => ({
    id: `a${++seq}`,
    ...r,
    createdAt: new Date(Date.UTC(2026, 10, 17, 0, 0, seq)),
  });
  const assignments: ShiftAssignmentRecord[] = [
    row({
      target: 'DEPARTMENT',
      companyId: CO,
      department: 'Front Desk',
      departmentKey: 'front desk',
      userId: null,
      shiftId: 'day',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      createdById: 'admin',
    }),
  ];
  if (opts.personal) {
    assignments.push(
      row({
        target: 'USER',
        companyId: CO,
        department: null,
        departmentKey: null,
        userId: 'u1',
        shiftId: opts.personal,
        effectiveFrom: '2026-11-01',
        effectiveTo: null,
        createdById: 'admin',
      }),
    );
  }
  const repo = {
    list: jest.fn(async () => [day, eve, own]),
    listAllAssignments: jest.fn(async () => [...assignments]),
    listDepartmentShifts: jest.fn(async () =>
      (opts.extras ?? ['eve']).map((shiftId) => ({
        companyId: CO,
        departmentKey: 'front desk',
        shiftId,
      })),
    ),
    applyAssignments: jest.fn(async (rows: NewAssignment[]) => {
      for (const r of rows) assignments.push(row(r));
    }),
  };
  const people = {
    findById: jest.fn(async () => ({ id: 'u1', companyId: CO, department: 'Front Desk' })),
    sharedComputerKeys: jest.fn(
      async () => new Set(opts.shared === false ? [] : [`${CO}|front desk`]),
    ),
  };
  const days = new BreakDayService(repo as never);
  const svc = new ShiftPickService(repo as never, people as never, days);
  const shiftOn = async (hm: string) =>
    (await days.dayFor({ id: 'u1', companyId: CO, department: 'Front Desk' }, at(hm))).resolved
      .shift?.id;
  return { svc, repo, assignments, shiftOn };
}

describe('ShiftPickService (4.1: a department with several shifts)', () => {
  it('gives the shift that is on at Start Day and stores it for that day only', async () => {
    const { svc, repo, shiftOn } = setup();
    const picked = await svc.pickOnStartDay('u1', at('17:30'));
    expect(picked?.shift.id).toBe('eve');
    expect(repo.applyAssignments).toHaveBeenCalledWith([
      expect.objectContaining({
        target: 'USER',
        userId: 'u1',
        shiftId: 'eve',
        effectiveFrom: '2026-11-17',
        effectiveTo: '2026-11-17',
        autoPicked: true,
      }),
    ]);
    expect(await shiftOn('18:00')).toBe('eve');
  });

  it('gives the next shift in a gap', async () => {
    const { svc } = setup();
    expect((await svc.pickOnStartDay('u1', at('16:00')))?.shift.id).toBe('eve');
  });

  it('keeps the first pick for the whole day', async () => {
    const { svc, repo } = setup();
    await svc.pickOnStartDay('u1', at('07:00'));
    expect(await svc.pickOnStartDay('u1', at('18:00'))).toBeNull();
    expect(repo.applyAssignments).toHaveBeenCalledTimes(1);
  });

  it("never replaces a person's own shift", async () => {
    const { svc, repo } = setup({ personal: 'own' });
    expect(await svc.pickOnStartDay('u1', at('18:00'))).toBeNull();
    expect(repo.applyAssignments).not.toHaveBeenCalled();
  });

  it('does nothing unless the department shares a computer', async () => {
    const { svc, repo } = setup({ shared: false });
    expect(await svc.pickOnStartDay('u1', at('18:00'))).toBeNull();
    expect(repo.applyAssignments).not.toHaveBeenCalled();
  });

  it('does nothing for a department with one shift', async () => {
    const { svc, repo } = setup({ extras: [] });
    expect(await svc.pickOnStartDay('u1', at('18:00'))).toBeNull();
    expect(repo.applyAssignments).not.toHaveBeenCalled();
  });
});
