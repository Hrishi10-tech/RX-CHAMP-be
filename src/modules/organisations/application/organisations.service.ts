import { Inject, Injectable } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OrganisationChangedEvent } from '@shared/events/organisation-changed.event';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { CompanyAssignedEvent } from '@modules/users/domain/events/company-assigned.event';
import { UserCreatedEvent } from '@modules/users/domain/events/user-created.event';
import { MIN_PASSWORD_LENGTH } from '@modules/users/application/user.constants';
import { normaliseOrgName, orgNameProblem } from '../domain/organisation.rules';
import {
  ORGANISATION_STORE,
  OrgAdminRef,
  OrgCounts,
  OrgRecord,
  OrgToday,
  OrganisationStore,
} from '../domain/organisation.store';

/** GET /organisations item (docs/4.0/SPEC.md 5.1). */
export interface OrganisationView {
  id: string;
  name: string;
  createdAt: string;
  admin: OrgAdminRef | null;
  counts: OrgCounts;
  today: OrgToday;
}

export interface OrganisationSummary {
  id: string;
  name: string;
  createdAt: string;
}

export interface PlatformOverview {
  organisations: OrganisationView[];
  /** People who belong to no organisation ("Needs an organisation"). */
  unassignedPeople: number;
}

export interface OrgAdminInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export interface OrgAdminView {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: 'ADMIN';
  companyId: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
}

export interface UnassignedPersonView {
  id: string;
  name: string;
  email: string;
  role: string;
  status: 'ACTIVE' | 'DISABLED';
}

export interface DeleteOrganisationResult {
  deleted: true;
  id: string;
  name: string;
  /** Blocked people soft-deleted with it (active people block the delete). */
  membersRemoved: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERSON_NAME_MAX = 60;

function summary(o: OrgRecord): OrganisationSummary {
  return { id: o.id, name: o.name, createdAt: o.createdAt.toISOString() };
}

function nameTakenError(name: string): ConflictError {
  return new ConflictError(`An organisation called "${name}" already exists.`, 'ORG_EXISTS');
}

function notFound(): NotFoundError {
  return new NotFoundError('That organisation does not exist.', 'ORG_NOT_FOUND');
}

/**
 * Organisations on the platform (docs/4.0/SPEC.md 5.1). Super Admin only: list,
 * create, rename, delete (refused while active people remain), create the one
 * Admin, and the platform overview. Every change is audited and announced so the
 * X-Org-Id cache forgets it.
 */
@Injectable()
export class OrganisationsService {
  constructor(
    @Inject(ORGANISATION_STORE) private readonly store: OrganisationStore,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly settings: AppSettingsService,
  ) {}

  private assertSuperAdmin(me: AuthenticatedUser): void {
    if (me.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenError('Only a Super Admin can manage organisations.');
    }
  }

  async list(me: AuthenticatedUser, now: Date = new Date()): Promise<OrganisationView[]> {
    this.assertSuperAdmin(me);
    return this.views(await this.store.list(), now);
  }

  /** The organisations as the old /companies list saw them: one, for an Admin or Manager. */
  async views(orgs: OrgRecord[], now: Date = new Date()): Promise<OrganisationView[]> {
    const ids = orgs.map((o) => o.id);
    const [admins, counts, today] = await Promise.all([
      this.store.admins(ids),
      this.store.counts(ids),
      this.store.today(ids, dateKeyInZone(now, appTimezone())),
    ]);
    return orgs.map((o) => ({
      ...summary(o),
      admin: admins.get(o.id) ?? null,
      counts: counts.get(o.id) ?? { staff: 0, managers: 0, departments: 0 },
      today: today.get(o.id) ?? { started: 0, working: 0, onBreak: 0, notStarted: 0 },
    }));
  }

  async platformOverview(me: AuthenticatedUser, now: Date = new Date()): Promise<PlatformOverview> {
    this.assertSuperAdmin(me);
    const [organisations, unassignedPeople] = await Promise.all([
      this.list(me, now),
      this.store.countUnassigned(),
    ]);
    return { organisations, unassignedPeople };
  }

  async get(me: AuthenticatedUser, id: string): Promise<OrganisationView> {
    this.assertSuperAdmin(me);
    const org = await this.store.findById(id);
    if (!org) throw notFound();
    return (await this.views([org]))[0];
  }

  async create(me: AuthenticatedUser, rawName: string): Promise<OrganisationSummary> {
    this.assertSuperAdmin(me);
    const name = this.checkedName(rawName);
    const outcome = await this.store.create(name, me.id);
    if (!outcome.ok) throw nameTakenError(name);
    await this.announce(outcome.org.id, 'CREATED');
    return summary(outcome.org);
  }

  async rename(me: AuthenticatedUser, id: string, rawName: string): Promise<OrganisationSummary> {
    this.assertSuperAdmin(me);
    const name = this.checkedName(rawName);
    const outcome = await this.store.rename(id, name, me.id);
    if (!outcome.ok) throw outcome.reason === 'NOT_FOUND' ? notFound() : nameTakenError(name);
    await this.announce(id, 'RENAMED');
    return summary(outcome.org);
  }

  async remove(me: AuthenticatedUser, id: string): Promise<DeleteOrganisationResult> {
    this.assertSuperAdmin(me);
    const org = await this.store.findById(id);
    if (!org) throw notFound();
    const notEmpty = (active: number) =>
      new ConflictError(
        `${org.name} still has ${active} active ${active === 1 ? 'person' : 'people'} (its Admin included). ` +
          'Delete or block them first.',
        'ORG_NOT_EMPTY',
      ).withDetails({ activePeople: active });
    // A cheap refusal first; the store counts again under the organisation's row
    // lock, so someone added at the same moment is counted or refused (never left
    // in a deleted organisation).
    const active = await this.store.countActivePeople(org.id);
    if (active > 0) throw notEmpty(active);
    const outcome = await this.store.softDelete(org.id, me.id);
    if (!outcome.ok) throw outcome.reason === 'NOT_FOUND' ? notFound() : notEmpty(outcome.active);
    await this.announce(org.id, 'DELETED');
    return { deleted: true, id: org.id, name: org.name, membersRemoved: outcome.membersRemoved };
  }

  async createAdmin(
    me: AuthenticatedUser,
    orgId: string,
    input: OrgAdminInput,
  ): Promise<OrgAdminView> {
    this.assertSuperAdmin(me);
    const org = await this.store.findById(orgId);
    if (!org) throw notFound();
    const firstName = (input.firstName ?? '').trim();
    const lastName = (input.lastName ?? '').trim();
    const email = (input.email ?? '').trim().toLowerCase();
    const password = input.password ?? '';
    if (!firstName || firstName.length > PERSON_NAME_MAX) {
      throw new ValidationError(
        `Enter a first name of up to ${PERSON_NAME_MAX} characters.`,
      ).withDetails({
        field: 'firstName',
      });
    }
    if (!lastName || lastName.length > PERSON_NAME_MAX) {
      throw new ValidationError(
        `Enter a last name of up to ${PERSON_NAME_MAX} characters.`,
      ).withDetails({
        field: 'lastName',
      });
    }
    if (!EMAIL_RE.test(email) || email.length > 254) {
      throw new ValidationError('Enter a valid email address.').withDetails({ field: 'email' });
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
      throw new ValidationError(
        `Use a password of ${MIN_PASSWORD_LENGTH} to 128 characters.`,
        'WEAK_PASSWORD',
      ).withDetails({ field: 'password' });
    }
    // Cheap refusal before hashing; the store re-checks under a row lock.
    if (await this.store.hasAdmin(org.id)) throw this.adminExists(org.name);

    const outcome = await this.store.createAdmin(
      {
        companyId: org.id,
        email,
        passwordHash: await this.hasher.hash(password),
        firstName,
        lastName,
      },
      me.id,
    );
    if (!outcome.ok) {
      if (outcome.reason === 'ORG_NOT_FOUND') throw notFound();
      if (outcome.reason === 'ADMIN_EXISTS') throw this.adminExists(org.name);
      throw new ConflictError('That email address is already in use.', 'EMAIL_IN_USE');
    }
    const a = outcome.admin;
    await this.events.publish(
      UserCreatedEvent.eventName,
      new UserCreatedEvent(a.id, a.email, Role.ADMIN, me.id, new Date()),
    );
    return {
      id: a.id,
      email: a.email,
      firstName: a.firstName,
      lastName: a.lastName,
      name: `${a.firstName} ${a.lastName}`.trim(),
      role: 'ADMIN',
      companyId: a.companyId,
      status: a.status,
      createdAt: a.createdAt.toISOString(),
    };
  }

  async listUnassigned(me: AuthenticatedUser): Promise<UnassignedPersonView[]> {
    this.assertSuperAdmin(me);
    return (await this.store.listUnassigned()).map((p) => ({
      id: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      email: p.email,
      role: p.role,
      status: p.status,
    }));
  }

  /**
   * Puts a person who belongs to no organisation (3.x leftovers, "Needs an
   * organisation") into one. Moving someone between organisations is refused:
   * their history, departments and approvals belong to the old one.
   */
  async assignPerson(
    me: AuthenticatedUser,
    orgId: string,
    userId: string,
  ): Promise<{ id: string; companyId: string; role: string; changed: boolean }> {
    this.assertSuperAdmin(me);
    const org = await this.store.findById(orgId);
    if (!org) throw notFound();
    const person = await this.store.findPerson(userId);
    if (!person || person.role === Role.SUPER_ADMIN) throw new NotFoundError('Unknown person');
    if (person.companyId === org.id) {
      return { id: person.id, companyId: org.id, role: person.role, changed: false };
    }
    if (person.companyId) {
      throw new ConflictError(
        'This person already belongs to another organisation. Moving people between organisations is not supported.',
        'PERSON_IN_ORGANISATION',
      );
    }
    if (person.role === Role.ADMIN && (await this.store.hasAdmin(org.id))) {
      throw this.adminExists(org.name);
    }
    // Checked again under the organisation's row lock (a delete or another Admin
    // at the same moment).
    const outcome = await this.store.assignPerson(person.id, org.id, me.id);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'ORG_NOT_FOUND':
          throw notFound();
        case 'PERSON_NOT_FOUND':
          throw new NotFoundError('Unknown person');
        case 'ADMIN_EXISTS':
          throw this.adminExists(org.name);
        default:
          throw new ConflictError(
            'This person already belongs to another organisation. Moving people between organisations is not supported.',
            'PERSON_IN_ORGANISATION',
          );
      }
    }
    if (!outcome.changed)
      return { id: person.id, companyId: org.id, role: person.role, changed: false };
    this.settings.forgetUser(person.id);
    const now = new Date();
    await this.events.publish(
      UserAccessChangedEvent.eventName,
      new UserAccessChangedEvent(person.id, ['ROLE'], now),
    );
    await this.events.publish(
      CompanyAssignedEvent.eventName,
      new CompanyAssignedEvent(person.id, person.role, org.id, org.name, me.id, now),
    );
    return { id: person.id, companyId: org.id, role: person.role, changed: true };
  }

  private adminExists(orgName: string): ConflictError {
    return new ConflictError(
      `${orgName} already has an Admin. Edit that Admin, or delete them before creating another.`,
      'ADMIN_EXISTS',
    );
  }

  private checkedName(raw: unknown): string {
    const problem = orgNameProblem(raw);
    if (problem) throw new ValidationError(problem).withDetails({ field: 'name' });
    return normaliseOrgName(raw as string);
  }

  private async announce(
    companyId: string,
    change: OrganisationChangedEvent['change'],
  ): Promise<void> {
    await this.events.publish(
      OrganisationChangedEvent.eventName,
      new OrganisationChangedEvent(companyId, change, new Date()),
    );
  }
}
