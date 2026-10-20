/**
 * 4.0: something every agent of an organisation should re-read changed: the
 * calendar (CALENDAR), input tracking (IDLE) or the organisation settings
 * (SETTINGS). The notifications gateway pushes `config:changed` {kind, at} to the
 * organisation's sockets; agents refresh today's config and their History.
 */
export type OrgConfigKind = 'CALENDAR' | 'IDLE' | 'SETTINGS';

export class OrgConfigChangedEvent {
  static readonly eventName = 'org.config-changed';

  constructor(
    public readonly companyId: string,
    public readonly kind: OrgConfigKind,
    public readonly at: Date,
  ) {}
}
