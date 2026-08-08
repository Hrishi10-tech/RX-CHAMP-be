export class UserCreatedEvent {
  static readonly eventName = 'user.created';

  constructor(
    public readonly userId: string,
    public readonly email: string,
    public readonly role: string,
    public readonly createdByUserId: string | null,
    public readonly occurredAt: Date,
  ) {}
}
