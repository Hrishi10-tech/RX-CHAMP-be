export class CompanyAssignedEvent {
  static readonly eventName = 'company.assigned';

  constructor(
    public readonly userId: string,
    public readonly userRole: string,
    public readonly companyId: string,
    public readonly companyName: string,
    public readonly assignedByUserId: string,
    public readonly occurredAt: Date,
  ) {}
}
