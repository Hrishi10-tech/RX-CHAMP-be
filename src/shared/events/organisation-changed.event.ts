export type OrganisationChange = 'CREATED' | 'RENAMED' | 'DELETED';

/**
 * An organisation was created, renamed or deleted (docs/4.0/SPEC.md 5.1). Caches
 * that remember organisations (the Super Admin's X-Org-Id check) forget it.
 */
export class OrganisationChangedEvent {
  static readonly eventName = 'organisation.changed';

  constructor(
    public readonly companyId: string,
    public readonly change: OrganisationChange,
    public readonly at: Date,
  ) {}
}
