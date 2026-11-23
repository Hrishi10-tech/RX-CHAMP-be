import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { LogPastMeetingDto, StartMeetingDto } from './meetings.dto';

/** The API's own pipe (bootstrap/configure-app.ts). */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: false,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const AGENDA = 'Give the meeting an agenda (1 to 300 characters).';
const PAST = { startedAt: '2026-10-14T05:30:00.000Z', durationMin: 45 };

/** What the pipe answers for a body: nothing, or the sentences it refuses it with. */
async function refused(metatype: typeof StartMeetingDto, body: object): Promise<unknown> {
  try {
    await pipe.transform(body, { type: 'body', metatype });
    return null;
  } catch (err) {
    return ((err as BadRequestException).getResponse() as { message: unknown }).message;
  }
}

describe.each([
  ['POST /meetings/start', StartMeetingDto, {}],
  ['POST /meetings/past', LogPastMeetingDto, PAST],
] as const)('C-757: the agenda on %s', (_route, dto, rest) => {
  it.each([
    ['empty', { agenda: '' }],
    ['301 characters', { agenda: 'x'.repeat(301) }],
    ['310 characters, even if they clean to 10', { agenda: `${' '.repeat(300)}0123456789` }],
    ['missing', {}],
    ['null', { agenda: null }],
    ['a list', { agenda: ['Review'] }],
  ])('%s: the deck sentence, once, and no validator words', async (_label, body) => {
    expect(await refused(dto, { ...rest, ...body })).toEqual([AGENDA]);
  });

  it.each([
    ['1 character', 'x'],
    ['300 characters', 'x'.repeat(300)],
    ['all spaces, which the service refuses in the same words and names the field', '   '],
  ])('%s passes the pipe', async (_label, agenda) => {
    expect(await refused(dto, { ...rest, agenda })).toBeNull();
  });
});
