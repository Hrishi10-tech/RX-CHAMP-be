import {
  DEPT_A1,
  IDS,
  ORG_A,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { cast, fakeUsers } from '../../testing/people.testing-spec';
import { GetProfileUseCase } from './get-profile.use-case';

/**
 * 4.0 (audit L6, docs/4.0/SPEC.md 5.3): GET /users/:id gives the full profile to
 * an Admin or Super Admin and to the person themselves; a Manager gets the same
 * brief row as their GET /users (no grants, input tracking, shift or status).
 */
function setup() {
  const people = cast();
  const users = fakeUsers(Object.values(people));
  return new GetProfileUseCase(users as never);
}

const BRIEF_KEYS = ['department', 'departmentRef', 'designation', 'email', 'id', 'name'];

describe('GET /users/:id shape (4.0)', () => {
  it('a Manager gets the brief row for their Staff', async () => {
    const useCase = setup();
    const view = await useCase.execute(manager([DEPT_A1], { timeline: true }), IDS.staffA1);
    expect(Object.keys(view).sort()).toEqual(BRIEF_KEYS);
    expect(view).not.toHaveProperty('role');
    expect(view).not.toHaveProperty('grants');
    expect(view).not.toHaveProperty('inputTracking');
  });

  it('the Admin and a Super Admin get the full profile', async () => {
    const useCase = setup();
    for (const me of [admin(ORG_A), superAdmin(ORG_A)]) {
      const view = await useCase.execute(me, IDS.staffA1);
      expect(view).toMatchObject({
        id: IDS.staffA1,
        role: expect.any(String),
        status: expect.any(String),
      });
    }
  });

  it('everyone gets their own full profile (the agent reads its role here)', async () => {
    const useCase = setup();
    await expect(useCase.execute(staff(), IDS.staffA1)).resolves.toHaveProperty('role');
    await expect(useCase.execute(manager([DEPT_A1]), IDS.managerA1)).resolves.toHaveProperty(
      'role',
    );
  });

  it('someone out of reach is still unknown (404)', async () => {
    const useCase = setup();
    await expect(useCase.execute(staff(), IDS.staffA2)).rejects.toMatchObject({ status: 404 });
    await expect(useCase.execute(manager([DEPT_A1]), IDS.staffA2)).rejects.toMatchObject({
      status: 404,
    });
  });
});
