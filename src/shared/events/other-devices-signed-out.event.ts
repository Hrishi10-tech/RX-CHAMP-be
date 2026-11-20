/**
 * Someone ended the sessions on their other devices themselves (a password change), so
 * their phones should stop getting pushes. Not a UserAccessChangedEvent: nothing about
 * who approves whom changed, and this device keeps a fresh session the sign-out of
 * that event would end.
 */
export class OtherDevicesSignedOutEvent {
  static readonly eventName = 'user.other-devices-signed-out';

  constructor(public readonly userId: string) {}
}
