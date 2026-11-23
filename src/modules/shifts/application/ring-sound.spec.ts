import { ValidationPipe } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { ShiftWriteData } from '../domain/shift.repository';
import { ShiftRecord } from '../domain/shift.types';
import { UpsertShiftDto } from './dto';
import { ShiftMapper } from './shift.mapper';
import { ManageShiftsUseCase } from './use-cases/manage-shifts.use-case';

/**
 * Brief 1.2, O-07: no alert makes a sound. 3.1 agents chime by `rules.ringSound`, so every
 * answer says false; the column stays, unread and unwritten; an old portal that still sends
 * the field is accepted and ignored.
 */
const ORG = 'org-a';
const RECORD: ShiftRecord = {
  id: 'shift-1',
  companyId: ORG,
  isDefault: true,
  name: 'General',
  start: '09:30',
  end: '18:30',
  workDays: [1, 2, 3, 4, 5],
  ringLeadMin: 1,
  ringDurationMin: 5,
  reasonOnEarly: true,
  reasonOnLate: true,
  reasonMinChars: 10,
  overrunReason: false,
  overrunGraceMin: 3,
  breaks: [],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

/** 4.0: the organisation admin writes the organisation's shifts. */
const ADMIN = {
  id: 'admin',
  role: Role.ADMIN,
  companyId: ORG,
  orgId: ORG,
  managedDepartmentIds: [],
} as unknown as AuthenticatedUser;

const BODY = {
  name: 'General',
  start: '09:30',
  end: '18:30',
  workDays: [1, 2, 3, 4, 5],
  breaks: [],
};

function useCase() {
  const repo = {
    findById: jest.fn().mockResolvedValue(RECORD),
    createUnique: jest.fn().mockResolvedValue({ ok: true, shift: RECORD }),
    updateUnique: jest.fn().mockResolvedValue({ ok: true, shift: RECORD }),
    listDefaults: jest.fn().mockResolvedValue([RECORD]),
  };
  const days = {
    invalidate: jest.fn(),
    context: jest.fn().mockResolvedValue({ assignments: [] }),
    resolveWith: jest.fn(() => ({ shift: null, source: 'NONE' })),
    timezone: 'Asia/Kolkata',
  };
  const people = { findMany: jest.fn().mockResolvedValue([]) };
  return { repo, uc: new ManageShiftsUseCase(repo as never, people as never, days as never) };
}

/** The API's own pipe (bootstrap/configure-app.ts) over the body an old portal sends. */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: false,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const parsed = (body: object): Promise<UpsertShiftDto> =>
  pipe.transform(body, { type: 'body', metatype: UpsertShiftDto }) as Promise<UpsertShiftDto>;

describe('ringSound answers false (brief 1.2, O-07)', () => {
  it('every shift view says false, and the other rules are as stored', () => {
    const view = ShiftMapper.shiftView(RECORD, { people: 0, departments: [], overrides: 0 });
    expect(view.rules).toEqual({
      ringLeadMin: 1,
      ringDurationMin: 5,
      ringSound: false,
      reasonOnEarly: true,
      reasonOnLate: true,
      reasonMinChars: 10,
      overrunReason: false,
      overrunGraceMin: 3,
    });
  });

  it.each([true, false])('an old portal sending %s is accepted and ignored', async (ringSound) => {
    const { uc, repo } = useCase();
    const created = await uc.create(ADMIN, await parsed({ ...BODY, ringSound }));
    const updated = await uc.update(ADMIN, 'shift-1', await parsed({ ...BODY, ringSound }));

    const written: ShiftWriteData[] = [
      repo.createUnique.mock.calls[0][0],
      repo.updateUnique.mock.calls[0][1],
    ];
    for (const data of written) expect(data).not.toHaveProperty('ringSound');
    expect(created.rules.ringSound).toBe(false);
    expect(updated.rules.ringSound).toBe(false);
  });

  it('a body with no ringSound at all is fine: the new portal sends none', async () => {
    const { uc, repo } = useCase();
    await uc.create(ADMIN, await parsed(BODY));
    expect(repo.createUnique.mock.calls[0][0]).not.toHaveProperty('ringSound');
  });
});
