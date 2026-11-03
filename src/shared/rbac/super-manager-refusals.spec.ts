import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from './authenticated-user';
import { Role } from './roles.enum';
import { RolesGuard } from './roles.guard';
import { SettingsController } from '@modules/settings/presentation/settings.controller';
import { IdleSettingsController } from '@modules/settings/presentation/idle-settings.controller';
import {
  ShiftAssignmentsController,
  ShiftsController,
} from '@modules/shifts/presentation/shifts.controller';
import { DepartmentsController } from '@modules/departments/presentation/departments.controller';
import { CalendarController } from '@modules/calendar/presentation/calendar.controller';
import { SignOutKeysController } from '@modules/signout-keys/presentation/signout-keys.controller';
import { RolesController } from '@modules/roles/presentation/roles.controller';
import { ReportsController } from '@modules/reports/presentation/reports.controller';
import {
  OrganisationsController,
  PlatformOverviewController,
} from '@modules/organisations/presentation/organisations.controller';
import { SuperManagersController } from '@modules/users/presentation/super-managers.controller';

/**
 * 3.3: the Super Manager reads and decides but administers nothing. These are the
 * routes a role guard alone must refuse it (403), checked against the real
 * decorators so a later @Roles change cannot quietly open one.
 */
type Ctor = { prototype: object; name: string };

function as(role: Role): AuthenticatedUser {
  return { id: 'me', email: 'me@x.test', role, permissions: [], companyId: null } as never;
}

function ctx(cls: Ctor, method: string, user: AuthenticatedUser): ExecutionContext {
  const handler = (cls.prototype as Record<string, unknown>)[method];
  if (typeof handler !== 'function') throw new Error(`${cls.name}.${method} is not a handler`);
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardSays(cls: Ctor, method: string, role: Role): number | 'allowed' {
  try {
    new RolesGuard(new Reflector()).canActivate(ctx(cls, method, as(role)));
    return 'allowed';
  } catch (e) {
    if (e instanceof AppException) return e.status;
    throw e;
  }
}

const REFUSED: [string, Ctor, string[]][] = [
  ['settings', SettingsController, ['patch']],
  ['input tracking', IdleSettingsController, ['get', 'put', 'putDepartment']],
  ['shifts editing', ShiftsController, ['validate', 'create', 'update', 'makeDefault', 'remove']],
  ['departments write', DepartmentsController, ['create', 'update', 'remove']],
  ['calendar edits', CalendarController, ['weekPattern', 'setDay', 'clearDay']],
  ['sign-out keys', SignOutKeysController, ['list', 'create', 'revoke']],
  ['roles', RolesController, ['create']],
  ['month locks', ReportsController, ['lock', 'unlock']],
  [
    'organisations',
    OrganisationsController,
    ['list', 'create', 'rename', 'remove', 'createAdmin', 'assignPerson'],
  ],
  [
    'platform overview',
    PlatformOverviewController,
    Object.getOwnPropertyNames(PlatformOverviewController.prototype).filter(
      (m) => m !== 'constructor',
    ),
  ],
  ['Super Manager accounts', SuperManagersController, ['list', 'create']],
];

describe('the Super Manager is refused administration (role guards)', () => {
  for (const [what, cls, methods] of REFUSED) {
    it(`${what}: 403 for the Super Manager, open to the Super Admin`, () => {
      for (const m of methods) {
        expect([m, guardSays(cls, m, Role.SUPER_MANAGER)]).toEqual([m, 403]);
        expect([m, guardSays(cls, m, Role.SUPER_ADMIN)]).toEqual([m, 'allowed']);
      }
    });
  }

  it('reads it needs stay open: shifts, shift assignments and departments lists', () => {
    expect(guardSays(ShiftsController, 'list', Role.SUPER_MANAGER)).toBe('allowed');
    expect(guardSays(ShiftAssignmentsController, 'people', Role.SUPER_MANAGER)).toBe('allowed');
    // 3.3: she assigns shifts (never creates or edits them).
    expect(guardSays(ShiftAssignmentsController, 'assignDepartment', Role.SUPER_MANAGER)).toBe(
      'allowed',
    );
    expect(guardSays(ShiftAssignmentsController, 'assignPeople', Role.SUPER_MANAGER)).toBe(
      'allowed',
    );
    expect(guardSays(DepartmentsController, 'list', Role.SUPER_MANAGER)).toBe('allowed');
  });
});
