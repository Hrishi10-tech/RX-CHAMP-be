/** Organisation rules (docs/4.0/SPEC.md 5.1). Pure. */

export const ORG_NAME = { min: 2, max: 80 } as const;

/** The name as stored: trimmed, inner whitespace collapsed. */
export function normaliseOrgName(raw: string): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ');
}

/** Two names clash when equal ignoring case and spacing. */
export function orgNameKey(raw: string): string {
  return normaliseOrgName(raw).toLowerCase();
}

export function orgNameProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'Name the organisation.';
  const name = normaliseOrgName(raw);
  if (name.length < ORG_NAME.min)
    return `Use at least ${ORG_NAME.min} characters for the organisation name.`;
  if (name.length > ORG_NAME.max)
    return `Keep the organisation name to ${ORG_NAME.max} characters or fewer.`;
  if (/[\u0000-\u001f\u007f]/.test(name))
    return 'The organisation name has characters that cannot be shown.';
  return null;
}

export function nameTaken(
  existing: readonly { id: string; name: string }[],
  name: string,
  exceptId: string | null = null,
): boolean {
  const key = orgNameKey(name);
  return existing.some((o) => o.id !== exceptId && orgNameKey(o.name) === key);
}
