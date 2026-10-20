export const ORGANISATION_STORE = Symbol('ORGANISATION_STORE');

export interface OrgRecord {
  id: string;
  name: string;
  createdAt: Date;
}

export interface OrgAdminRef {
  id: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
}

export interface OrgCounts {
  staff: number;
  managers: number;
  departments: number;
}

export interface OrgToday {
  started: number;
  working: number;
  onBreak: number;
  notStarted: number;
}

export interface OrgPerson {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  status: 'ACTIVE' | 'DISABLED';
  /** Their organisation when it still exists (a deleted one counts as none). */
  companyId: string | null;
}

export interface NewOrgAdmin {
  companyId: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
}

export interface CreatedAdmin {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: 'ACTIVE' | 'DISABLED';
  companyId: string;
  createdAt: Date;
}

export type CreateAdminOutcome =
  | { ok: true; admin: CreatedAdmin }
  | { ok: false; reason: 'ORG_NOT_FOUND' | 'ADMIN_EXISTS' | 'EMAIL_IN_USE' };

export type NameOutcome =
  | { ok: true; org: OrgRecord }
  | { ok: false; reason: 'NAME_TAKEN' | 'NOT_FOUND' };

export type DeleteOutcome =
  | { ok: true; membersRemoved: number }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'NOT_EMPTY'; active: number };

export type AssignOutcome =
  | { ok: true; changed: boolean }
  | {
      ok: false;
      reason: 'ORG_NOT_FOUND' | 'PERSON_NOT_FOUND' | 'PERSON_IN_ORGANISATION' | 'ADMIN_EXISTS';
    };

/**
 * Persistence of organisations (the companies table) and the platform figures.
 * Writes record their audit row in the same transaction (`actorId`).
 */
export interface OrganisationStore {
  /** Every organisation not deleted, by name. */
  list(): Promise<OrgRecord[]>;
  findById(id: string): Promise<OrgRecord | null>;
  /** Creates with a unique name (case and spacing ignored), serialised against other writers. */
  create(name: string, actorId: string): Promise<NameOutcome>;
  rename(id: string, name: string, actorId: string): Promise<NameOutcome>;
  /** Not deleted, status ACTIVE, any role. */
  countActivePeople(id: string): Promise<number>;
  /**
   * Soft-deletes the organisation, its departments and the (blocked) people still
   * in it with one stamp, and revokes its sign-out keys, under the organisation's
   * row lock and only while nobody active is in it (counted under that lock, so a
   * person added at the same moment is either counted or refused). Answers the
   * people removed.
   */
  softDelete(id: string, actorId: string): Promise<DeleteOutcome>;
  /** The Admin (not deleted) of each organisation. */
  admins(ids: string[]): Promise<Map<string, OrgAdminRef>>;
  counts(ids: string[]): Promise<Map<string, OrgCounts>>;
  /** Today's start figures per organisation, one aggregated query. */
  today(ids: string[], dateKey: string): Promise<Map<string, OrgToday>>;
  /** People (not Super Admins, not deleted) with no organisation, or a deleted one. */
  listUnassigned(): Promise<OrgPerson[]>;
  countUnassigned(): Promise<number>;
  findPerson(id: string): Promise<OrgPerson | null>;
  /** Creates the organisation's Admin unless it has one (not deleted) already. */
  createAdmin(data: NewOrgAdmin, actorId: string): Promise<CreateAdminOutcome>;
  /** Whether the organisation has an Admin (not deleted). */
  hasAdmin(companyId: string): Promise<boolean>;
  /**
   * Puts a person with no organisation into one: department, managed departments,
   * reporting line and grants are cleared (they belonged to no organisation). Under
   * the organisation's row lock: a deleted organisation is refused, and so is a
   * second Admin.
   */
  assignPerson(userId: string, companyId: string, actorId: string): Promise<AssignOutcome>;
}
