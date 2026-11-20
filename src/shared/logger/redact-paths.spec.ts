import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACT_PATHS } from './redact-paths';

function logged(record: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk: Buffer, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  pino({ redact: LOG_REDACT_PATHS }, sink).info(record);
  return out;
}

describe('LOG_REDACT_PATHS', () => {
  it('keeps secrets in request headers out of the log', () => {
    const line = logged({
      req: {
        headers: {
          authorization: 'Bearer secret-a',
          cookie: 'access=secret-b',
          'x-biometric-key': 'rxb_secret-c',
          'user-agent': 'kept',
        },
      },
    });
    expect(line).not.toContain('secret-a');
    expect(line).not.toContain('secret-b');
    expect(line).not.toContain('secret-c');
    expect(line).toContain('kept');
  });
});
