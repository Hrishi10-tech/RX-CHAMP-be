import { StartPresenceUseCase } from './start-presence.use-case';

function setup(attendanceSource: 'AGENT' | 'BIOMETRIC') {
  const sessions = {
    switchTo: jest.fn().mockResolvedValue({
      closed: null,
      opened: {
        id: 'ps1',
        userId: 'u1',
        deviceId: null,
        type: 'BREAK',
        note: null,
        date: '2026-11-05',
        startedAt: new Date(),
        endedAt: null,
        durationSec: null,
      },
    }),
  };
  const team = {
    findContext: jest.fn().mockResolvedValue({
      self: { id: 'u1', firstName: 'Asha', lastName: 'Rao', email: 'a@x.test', department: null },
      managerId: null,
      attendanceSource,
    }),
  };
  const dayEnds = { findEnd: jest.fn().mockResolvedValue(null) };
  const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const gateway = { emitForSubject: jest.fn().mockResolvedValue(undefined) };
  const day = { ensureOpen: jest.fn().mockResolvedValue(null) };
  const useCase = new StartPresenceUseCase(
    sessions as never,
    team as never,
    dayEnds as never,
    events as never,
    gateway as never,
    day as never,
  );
  return { useCase, sessions, events };
}

describe('POST /presence/start and biometric staff (D-23)', () => {
  it.each(['BREAK', 'LUNCH', 'MEETING'] as const)(
    'a leftover agent cannot start a %s: it would cut a biometric day',
    async (type) => {
      const { useCase, sessions, events } = setup('BIOMETRIC');
      await expect(useCase.execute('u1', { type })).rejects.toMatchObject({
        status: 409,
        code: 'ATTENDANCE_BY_BIOMETRIC',
      });
      expect(sessions.switchTo).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    },
  );

  it('agent staff carry on as before', async () => {
    const { useCase, sessions } = setup('AGENT');
    await expect(useCase.execute('u1', { type: 'BREAK' })).resolves.toMatchObject({
      status: 'BREAK',
    });
    expect(sessions.switchTo).toHaveBeenCalledTimes(1);
  });
});
