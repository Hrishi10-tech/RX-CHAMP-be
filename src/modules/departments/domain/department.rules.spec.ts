import {
  DEPARTMENT_ICONS,
  departmentNameKey,
  departmentNameProblem,
  isDepartmentIcon,
  normaliseDepartmentName,
} from './department.rules';
import { departmentKey } from '@modules/shifts/domain/shift.types';

describe('department rules', () => {
  it('stores the name trimmed with single spaces', () => {
    expect(normaliseDepartmentName('  Research   and  Development ')).toBe(
      'Research and Development',
    );
  });

  it('compares names ignoring case and spacing, like the database index and shift matching', () => {
    expect(departmentNameKey(' R&D   Lab')).toBe(departmentNameKey('r&d lab'));
    for (const name of ['Sales', '  Customer   Support ', 'QA\tTeam']) {
      expect(departmentNameKey(name)).toBe(departmentKey(name));
    }
  });

  it.each([
    ['', 'Name the department.'],
    ['   ', 'Name the department.'],
    [undefined, 'Name the department.'],
    ['x'.repeat(61), 'Keep the department name to 60 characters or fewer.'],
  ])('refuses %p', (raw, message) => {
    expect(departmentNameProblem(raw)).toBe(message);
  });

  it('accepts 1 and 60 characters (after trimming)', () => {
    expect(departmentNameProblem(' A ')).toBeNull();
    expect(departmentNameProblem(` ${'y'.repeat(60)} `)).toBeNull();
  });

  it('refuses control characters', () => {
    expect(departmentNameProblem('Sales\u0007')).toMatch(/cannot be shown/);
  });

  it('knows the 40 themed icons of SPEC 7.6 and nothing else', () => {
    expect(DEPARTMENT_ICONS).toHaveLength(40);
    expect(new Set(DEPARTMENT_ICONS).size).toBe(40);
    expect(isDepartmentIcon('circuit-board')).toBe(true);
    expect(isDepartmentIcon('hard-hat')).toBe(true);
    expect(isDepartmentIcon('skull')).toBe(false);
    expect(isDepartmentIcon(undefined)).toBe(false);
  });
});
