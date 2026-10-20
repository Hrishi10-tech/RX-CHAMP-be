/**
 * Department rules (docs/4.0/SPEC.md 2.1 and 7.6). Pure: no Nest, no Prisma.
 */

/** The themed icon set a department picks from (SPEC 7.6, Lucide names). */
export const DEPARTMENT_ICONS = Object.freeze([
  'code',
  'cpu',
  'circuit-board',
  'wrench',
  'flask',
  'microscope',
  'heart-pulse',
  'stethoscope',
  'package',
  'truck',
  'warehouse',
  'shopping-cart',
  'bar-chart',
  'line-chart',
  'megaphone',
  'headphones',
  'users',
  'user-cog',
  'wallet',
  'calculator',
  'scale',
  'shield-check',
  'badge-check',
  'settings',
  'pencil',
  'palette',
  'camera',
  'book-open',
  'graduation-cap',
  'building',
  'briefcase',
  'globe',
  'factory',
  'boxes',
  'clipboard-list',
  'messages',
  'rocket',
  'leaf',
  'landmark',
  'hard-hat',
] as const);

export type DepartmentIcon = (typeof DEPARTMENT_ICONS)[number];

export const DEFAULT_DEPARTMENT_ICON: DepartmentIcon = 'briefcase';

export const DEPARTMENT_NAME = { min: 1, max: 60 } as const;

export function isDepartmentIcon(value: unknown): value is DepartmentIcon {
  return typeof value === 'string' && (DEPARTMENT_ICONS as readonly string[]).includes(value);
}

/** The name as stored: trimmed, inner whitespace collapsed to one space. */
export function normaliseDepartmentName(raw: string): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * The key two names clash on: case and spacing ignored. Matches the database index
 * departments_company_name_key and the shifts module's departmentKey().
 */
export function departmentNameKey(raw: string): string {
  return normaliseDepartmentName(raw).toLowerCase();
}

/** A plain-English problem with the name, or null when it is acceptable. */
export function departmentNameProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Name the department.';
  const name = normaliseDepartmentName(raw);
  if (name.length < DEPARTMENT_NAME.min) return 'Name the department.';
  if (name.length > DEPARTMENT_NAME.max) {
    return `Keep the department name to ${DEPARTMENT_NAME.max} characters or fewer.`;
  }
  // Control characters never belong in a name shown in menus and exports.
  if (/[\u0000-\u001f\u007f]/.test(name))
    return 'The department name has characters that cannot be shown.';
  return null;
}
