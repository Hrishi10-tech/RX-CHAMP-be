import { Inject, Injectable } from '@nestjs/common';
import { AVATAR_SIZES, AvatarCatalog, libraryOf } from '@shared/avatars/avatar-catalog';
import { AvatarChangedEvent } from '@shared/events/avatar-changed.event';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { User } from '@modules/users/domain/entities/user.entity';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';
import {
  UserAccessService,
  canSetGender,
} from '@modules/users/domain/services/user-access.service';
import { AvatarManifestView, MyAvatarView, UserAvatarResetView } from './avatar.types';

/** The clients Staff may change their avatar from (D-15): the desktop agent and the phone. */
const STAFF_CLIENTS = /^(RXVisionAgent|RXVisionMobile)\//;

/**
 * Preset avatars (3.6). Only a manifest ID from the person's own gender's library is
 * ever stored. Staff change theirs from the agent or the phone only; everyone else
 * from anywhere. That limit is a product rule, not a security boundary: a User-Agent
 * can be forged, and what it protects is a preset picture.
 *
 * 4.0: someone else's avatar is put back on its default by whoever may set their
 * gender (canSetGender): their organisation's Admin or a Super Admin.
 */
@Injectable()
export class AvatarService {
  private readonly access = new UserAccessService();

  constructor(
    private readonly catalog: AvatarCatalog,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  /** `prefix`: the API's route prefix, so every URL works as given. */
  manifest(prefix: string): AvatarManifestView {
    return {
      version: this.catalog.version,
      defaults: { ...this.catalog.defaults },
      avatars: this.catalog.entries.map((entry) => ({
        id: entry.id,
        gender: entry.gender,
        set: entry.set,
        files: Object.fromEntries(
          AVATAR_SIZES.map((size) => {
            const hash = this.catalog.contentHash(size, entry.id);
            const url = `/${prefix}/avatars/files/${size}/${entry.id}.webp`;
            return [String(size), hash ? `${url}?v=${hash}` : url];
          }),
        ),
      })),
    };
  }

  async mine(me: AuthenticatedUser): Promise<MyAvatarView> {
    return this.view(await this.load(me.id));
  }

  async choose(
    me: AuthenticatedUser,
    avatarId: string,
    userAgent: string | undefined,
  ): Promise<MyAvatarView> {
    this.assertMayChange(me, userAgent);
    const entry = this.catalog.find(avatarId);
    if (!entry) throw new ValidationError('That is not one of the avatars.', 'AVATAR_UNKNOWN');
    const user = await this.load(me.id);
    const library = libraryOf(user.gender);
    if (!library) {
      throw new ConflictError(
        'Your avatar can be chosen once your admin has set up your profile.',
        'GENDER_NOT_SET',
      );
    }
    if (entry.gender !== library) {
      throw new ForbiddenError('You can pick only from your own avatars.', 'AVATAR_OTHER_LIBRARY');
    }
    return this.view(await this.store(user, entry.id));
  }

  async resetMine(me: AuthenticatedUser, userAgent: string | undefined): Promise<MyAvatarView> {
    this.assertMayChange(me, userAgent);
    return this.view(await this.store(await this.load(me.id), null));
  }

  /**
   * An organisation admin (their Managers and Staff) or a Super Admin (anyone but
   * another Super Admin, in the organisation picked) puts someone back on the default
   * for their gender. Out of sight: 404; in sight but not theirs to change: 403.
   */
  async resetFor(me: AuthenticatedUser, targetId: string): Promise<UserAvatarResetView> {
    const target = this.access.assertCanEdit(me, await this.users.findById(targetId));
    if (!canSetGender(me, target)) {
      throw new ForbiddenError(
        'Only the organisation admin or a Super Admin can reset an avatar.',
        'AVATAR_RESET_FORBIDDEN',
      );
    }
    const saved = await this.store(target, null);
    return { userId: saved.id, avatarId: this.effective(saved) };
  }

  private assertMayChange(me: AuthenticatedUser, userAgent: string | undefined): void {
    if (me.role === Role.USER && !STAFF_CLIENTS.test(userAgent ?? '')) {
      throw new ForbiddenError(
        'You can change your avatar from the agent or the phone app.',
        'AVATAR_CHANGE_ON_WEB',
      );
    }
  }

  private async load(id: string): Promise<User> {
    const user = await this.users.findById(id);
    if (!user) throw new NotFoundError('Unknown user');
    return user;
  }

  private async store(user: User, avatarId: string | null): Promise<User> {
    user.chooseAvatar(avatarId);
    const saved = await this.users.save(user);
    await this.events.publish(
      AvatarChangedEvent.eventName,
      new AvatarChangedEvent(saved.id, this.effective(saved), saved.companyId),
    );
    return saved;
  }

  private effective(user: User): string | null {
    return this.catalog.effective(user.gender, user.avatarId);
  }

  private view(user: User): MyAvatarView {
    const library = libraryOf(user.gender);
    return {
      avatarId: this.effective(user),
      chosenAvatarId: user.avatarId,
      defaultAvatarId: library ? this.catalog.defaults[library] : null,
      library,
    };
  }
}
