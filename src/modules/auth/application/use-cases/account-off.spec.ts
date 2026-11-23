import { EnrollAgentUseCase } from './enroll-agent.use-case';
import { RefreshTokenUseCase } from './refresh-token.use-case';

// 4.0: the organisation admin turns an account back on (Managers do not edit people).
const OFF = 'Ask the organisation admin to turn your account back on.';
const meta = { userAgent: 'jest', ip: '127.0.0.1' };

describe('a blocked account, wherever it asks (C-672, C-675)', () => {
  it('a refresh that rotates, then finds the account is off', async () => {
    const useCase = new RefreshTokenUseCase(
      {} as never,
      { rotate: jest.fn(async () => ({ userId: 'u1', token: 'next' })) } as never,
      { loadById: jest.fn(async () => ({ id: 'u1', status: 'DISABLED' })) } as never,
    );
    await expect(useCase.execute('raw', meta)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: OFF,
    });
  });

  it('a refresh with a token that no longer rotates is only asked to sign in again', async () => {
    const useCase = new RefreshTokenUseCase(
      {} as never,
      { rotate: jest.fn(async () => null) } as never,
      {} as never,
    );
    await expect(useCase.execute('raw', meta)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Sign in again to carry on.',
    });
  });

  it('an enrolment by an account that is off', async () => {
    const useCase = new EnrollAgentUseCase(
      {
        findById: jest.fn(async () => ({ id: 'u1', enrollVersion: 1, isActive: () => false })),
        authEpochOf: jest.fn(async () => 3),
      } as never,
      {
        verifyEnrollmentToken: jest.fn(async () => ({
          userId: 'u1',
          enrollVersion: 1,
          epoch: 3,
          mintedBy: null,
        })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(useCase.execute('token', meta)).rejects.toMatchObject({
      status: 403,
      code: 'ACCOUNT_DISABLED',
      message: OFF,
    });
  });
});
