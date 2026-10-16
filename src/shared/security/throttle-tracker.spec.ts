import { JwtService } from '@nestjs/jwt';
import { throttleTracker } from './throttle-tracker';

describe('throttleTracker', () => {
  const jwt = new JwtService({ secret: 'test-secret-test-secret-test-secret' });
  const track = throttleTracker(jwt);

  it('counts a signed-in request against the person', () => {
    const token = jwt.sign({ sub: 'u-1' });
    expect(track({ cookies: { accessToken: token }, ip: '1.2.3.4' })).toBe('user:u-1');
    expect(track({ headers: { authorization: `Bearer ${token}` }, ip: '1.2.3.4' })).toBe(
      'user:u-1',
    );
  });

  it('falls back to the address for forged, foreign or socket tokens', () => {
    const forged = new JwtService({ secret: 'another-secret' }).sign({ sub: 'u-1' });
    expect(track({ cookies: { accessToken: forged }, ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    const socket = jwt.sign({ sub: 'u-1', typ: 'socket' });
    expect(track({ cookies: { accessToken: socket }, ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    expect(track({ ip: '5.6.7.8' })).toBe('ip:5.6.7.8');
  });
});
