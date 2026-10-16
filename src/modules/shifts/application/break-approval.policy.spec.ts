import { BreakApprovalPolicy } from './break-approval.policy';
import { ShiftPerson } from '../domain/shift-people.reader';
import { BreakRecordRow } from '../domain/break-record.repository';
import { toPerson } from '../infrastructure/prisma-shift-people.reader';

function person(
  id: string,
  role: ShiftPerson['role'],
  over: Partial<ShiftPerson> = {},
): ShiftPerson {
  return {
    id,
    role,
    firstName: id,
    lastName: '',
    email: `${id}@x.test`,
    department: null,
    designation: null,
    companyId: null,
    managerId: null,
    active: true,
    ...over,
  };
}

function record(over: Partial<BreakRecordRow>): BreakRecordRow {
  return {
    userId: 'staff',
    approverId: null,
    approverRole: null,
    approvalStatus: 'PENDING',
    ...over,
  } as BreakRecordRow;
}

describe('BreakApprovalPolicy.route', () => {
  it('sends staff breaks to their manager', () => {
    const r = BreakApprovalPolicy.route(person('staff', 'USER'), person('mgr', 'MANAGER'));
    expect(r).toEqual({ status: 'PENDING', approverRole: 'MANAGER', approverId: 'mgr' });
  });

  it('sends staff with an inactive or missing manager to the Super Admin pool', () => {
    expect(
      BreakApprovalPolicy.route(
        person('staff', 'USER'),
        person('mgr', 'MANAGER', { active: false }),
      ),
    ).toEqual({
      status: 'PENDING',
      approverRole: 'SUPER_ADMIN',
      approverId: null,
    });
    expect(BreakApprovalPolicy.route(person('staff', 'USER'), null).approverRole).toBe(
      'SUPER_ADMIN',
    );
  });

  it('a soft-deleted manager is never an approver, whatever their status says', () => {
    const row = {
      id: 'mgr',
      firstName: 'Maya',
      lastName: 'Reddy',
      email: 'maya@x.test',
      department: null,
      designation: null,
      companyId: null,
      managerId: null,
      status: 'ACTIVE' as const,
      deletedAt: new Date('2026-10-01T00:00:00Z'),
      role: { name: 'MANAGER' as const },
    };
    const deleted = toPerson(row);
    expect(deleted.active).toBe(false);
    expect(toPerson({ ...row, deletedAt: null }).active).toBe(true);
    expect(toPerson({ ...row, deletedAt: null, status: 'DISABLED' }).active).toBe(false);
    expect(BreakApprovalPolicy.route(person('staff', 'USER'), deleted)).toEqual({
      status: 'PENDING',
      approverRole: 'SUPER_ADMIN',
      approverId: null,
    });
  });

  it('sends staff reporting straight to a Super Admin to that Super Admin', () => {
    expect(BreakApprovalPolicy.route(person('staff', 'USER'), person('sa', 'SUPER_ADMIN'))).toEqual(
      {
        status: 'PENDING',
        approverRole: 'SUPER_ADMIN',
        approverId: 'sa',
      },
    );
  });

  it("sends a manager's breaks to the Super Admin pool, every day", () => {
    expect(
      BreakApprovalPolicy.route(person('mgr', 'MANAGER'), person('sa', 'SUPER_ADMIN')),
    ).toEqual({
      status: 'PENDING',
      approverRole: 'SUPER_ADMIN',
      approverId: null,
    });
  });

  it('needs nothing for a Super Admin', () => {
    expect(BreakApprovalPolicy.route(person('sa', 'SUPER_ADMIN'), null).status).toBe(
      'NOT_REQUIRED',
    );
  });

  it('never routes to staff', () => {
    expect(
      BreakApprovalPolicy.route(person('staff', 'USER'), person('peer', 'USER')).approverRole,
    ).toBe('SUPER_ADMIN');
  });
});

describe('BreakApprovalPolicy.canDecide', () => {
  it('lets a manager decide only what was routed to them', () => {
    expect(
      BreakApprovalPolicy.canDecide({ id: 'mgr', role: 'MANAGER' }, record({ approverId: 'mgr' })),
    ).toBe(true);
    expect(
      BreakApprovalPolicy.canDecide(
        { id: 'mgr', role: 'MANAGER' },
        record({ approverId: 'other' }),
      ),
    ).toBe(false);
    expect(
      BreakApprovalPolicy.canDecide(
        { id: 'mgr', role: 'MANAGER' },
        record({ approverRole: 'SUPER_ADMIN' }),
      ),
    ).toBe(false);
  });

  it('lets a Super Admin decide anything but their own', () => {
    expect(
      BreakApprovalPolicy.canDecide(
        { id: 'sa', role: 'SUPER_ADMIN' },
        record({ approverId: 'mgr' }),
      ),
    ).toBe(true);
    expect(
      BreakApprovalPolicy.canDecide({ id: 'sa', role: 'SUPER_ADMIN' }, record({ userId: 'sa' })),
    ).toBe(false);
  });

  it('never lets staff decide, nor anyone decide their own', () => {
    expect(
      BreakApprovalPolicy.canDecide({ id: 'staff', role: 'USER' }, record({ approverId: 'staff' })),
    ).toBe(false);
    expect(
      BreakApprovalPolicy.canDecide(
        { id: 'mgr', role: 'MANAGER' },
        record({ userId: 'mgr', approverId: 'mgr' }),
      ),
    ).toBe(false);
  });
});
