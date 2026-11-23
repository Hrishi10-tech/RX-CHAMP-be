import { ConflictError } from './app.exception';

/**
 * 409 ATTENDANCE_BY_BIOMETRIC (3.5, docs/3.5/AGENT.md): someone whose day comes from the
 * biometric device gets this for every Start Day, End Day, break or meeting call.
 */
export function attendanceByBiometric(action: 'start' | 'end' | 'act'): ConflictError {
  return new ConflictError(
    action === 'start'
      ? 'Your attendance is recorded by the biometric device: your day starts with your first punch there.'
      : action === 'end'
        ? 'Your attendance is recorded by the biometric device: your day ends with your last punch there.'
        : 'Your attendance is recorded by the biometric device, so the desktop app does not track your day.',
    'ATTENDANCE_BY_BIOMETRIC',
  );
}
