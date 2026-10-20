import { Inject, Injectable } from '@nestjs/common';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';

/**
 * Who hears about a person's own events (day ended, agent activated, meeting note):
 * 4.0 replaces users.manager_id with departments (docs/4.0/SPEC.md 1.3).
 *  - Staff: the managers of their department; the organisation's Admin when the
 *    department has none (or they have no department).
 *  - Manager: the organisation's Admin.
 *  - Admin and Super Admin: nobody.
 * Never across organisations, never the person themselves.
 */
@Injectable()
export class OversightRecipients {
  constructor(@Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader) {}

  async of(userId: string): Promise<string[]> {
    const p = await this.people.findById(userId);
    if (!p || !p.companyId) return [];
    let ids: string[] = [];
    if (p.role === 'USER') {
      ids = p.departmentId ? await this.people.listDepartmentManagerIds(p.departmentId) : [];
      if (!ids.length) ids = await this.people.listOrgAdminIds(p.companyId);
    } else if (p.role === 'MANAGER') {
      ids = await this.people.listOrgAdminIds(p.companyId);
    }
    return [...new Set(ids)].filter((id) => id !== userId);
  }
}
