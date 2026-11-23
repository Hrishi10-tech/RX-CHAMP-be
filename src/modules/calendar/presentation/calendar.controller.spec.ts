import { NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { CalendarController } from './calendar.controller';

const ORG = 'co-1';
const me = (id: string, role: Role) =>
  ({
    id,
    role,
    companyId: ORG,
    orgId: ORG,
    managedDepartmentIds: [],
  }) as unknown as AuthenticatedUser;

describe("CalendarController: a year for someone who isn't there", () => {
  const facts = { find: jest.fn(async () => null) };
  const calendar = { personYear: jest.fn() };
  const controller = new CalendarController(calendar as never, facts as never);

  it("C-911: someone else's year is told about that person, not their own profile", async () => {
    const asked = controller.personYear(me('admin', Role.ADMIN), 'gone', {});
    await expect(asked).rejects.toBeInstanceOf(NotFoundException);
    await expect(asked).rejects.toThrow("We can't find that person. Refresh and try again.");
  });

  it('C-690: their own year still says your profile', async () => {
    await expect(controller.personYear(me('u1', Role.USER), 'u1', {})).rejects.toThrow(
      "We can't find your profile. Sign in again.",
    );
    expect(calendar.personYear).not.toHaveBeenCalled();
  });
});
