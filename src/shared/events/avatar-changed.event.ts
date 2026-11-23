/**
 * A person's effective avatar changed (3.6): they picked one, reset it, an admin
 * reset it or changed their gender. The notifications socket passes it on as
 * `avatar:changed` to their own devices and to the people shown them (4.0: see
 * avatarRoomsOf in shared/websocket/socket-rooms), so every open app updates within
 * seconds.
 */
export class AvatarChangedEvent {
  static readonly eventName = 'avatar.changed';

  constructor(
    public readonly userId: string,
    /** The effective avatar now; null while the person has no gender. */
    public readonly avatarId: string | null,
    public readonly companyId: string | null,
  ) {}
}
