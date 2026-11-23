import { lastValueFrom, Observable, of, throwError } from 'rxjs';
import { ApprovalChangedEvent } from '@shared/events/approval-changed.event';
import { approvalChangesOf, ApprovalChangeInterceptor } from './approval-change.interceptor';

const P = '/api/v1';

describe('approvalChangesOf (3.6)', () => {
  it.each([
    ['/approvals/break/b1/approve', 'BREAK', 'b1', 'DECIDED'],
    ['/approvals/break/b1/reject', 'BREAK', 'b1', 'DECIDED'],
    ['/approvals/break/b1/reopen', 'BREAK', 'b1', 'REOPENED'],
    ['/approvals/meeting/m1/approve', 'MEETING', 'm1', 'DECIDED'],
    ['/approvals/meeting/m1/reject', 'MEETING', 'm1', 'DECIDED'],
    ['/approvals/meeting/m1/reopen', 'MEETING', 'm1', 'REOPENED'],
    ['/breaks/approvals/b2/approve', 'BREAK', 'b2', 'DECIDED'],
    ['/breaks/approvals/b2/reject', 'BREAK', 'b2', 'DECIDED'],
    ['/breaks/approvals/b2/reopen', 'BREAK', 'b2', 'REOPENED'],
    ['/leave/requests/l1/approve', 'LEAVE', 'l1', 'DECIDED'],
    ['/leave/requests/l1/reject', 'LEAVE', 'l1', 'DECIDED'],
    ['/leave/requests/l1/revoke', 'LEAVE', 'l1', 'REVOKED'],
    ['/leave/requests/l1/cancel', 'LEAVE', 'l1', 'CANCELLED'],
    ['/wfh/requests/w1/approve', 'WFH', 'w1', 'DECIDED'],
    ['/wfh/requests/w1/reject', 'WFH', 'w1', 'DECIDED'],
    ['/wfh/requests/w1/revoke', 'WFH', 'w1', 'REVOKED'],
    ['/wfh/requests/w1/cancel', 'WFH', 'w1', 'CANCELLED'],
    ['/leave/comp-off/claims/c1/approve', 'COMPOFF', 'c1', 'DECIDED'],
    ['/leave/comp-off/claims/c1/reject', 'COMPOFF', 'c1', 'DECIDED'],
    ['/leave/comp-off/claims/c1/revoke', 'COMPOFF', 'c1', 'REVOKED'],
    ['/leave/comp-off/claims/c1/cancel', 'COMPOFF', 'c1', 'CANCELLED'],
  ])('POST %s is %s %s %s', (path, what, id, action) => {
    expect(approvalChangesOf('POST', `${P}${path}`, { id: 'from-the-answer' })).toEqual([
      { what, id, action },
    ]);
  });

  it.each([
    ['/leave/requests', 'LEAVE'],
    ['/wfh/requests', 'WFH'],
    ['/leave/comp-off/claims', 'COMPOFF'],
    ['/leave/comp-off/grants', 'COMPOFF'],
  ])('a new item at POST %s takes its id from the answer', (path, what) => {
    expect(approvalChangesOf('POST', `${P}${path}`, { id: 'n1' })).toEqual([
      { what, id: 'n1', action: 'CREATED' },
    ]);
    expect(approvalChangesOf('POST', `${P}${path}`, {})).toEqual([]);
    expect(approvalChangesOf('POST', `${P}${path}`, null)).toEqual([]);
  });

  it('bulk approve names only what was approved, in either answer', () => {
    expect(
      approvalChangesOf('POST', `${P}/approvals/bulk-approve`, {
        approved: [
          { type: 'break', id: 'b1' },
          { type: 'meeting', id: 'm1' },
        ],
        skipped: [{ type: 'break', id: 'b2', reason: 'Already approved.' }],
      }),
    ).toEqual([
      { what: 'BREAK', id: 'b1', action: 'DECIDED' },
      { what: 'MEETING', id: 'm1', action: 'DECIDED' },
    ]);
    expect(
      approvalChangesOf('POST', `${P}/breaks/approvals/bulk-approve`, {
        approved: ['b1'],
        skipped: [],
      }),
    ).toEqual([{ what: 'BREAK', id: 'b1', action: 'DECIDED' }]);
    expect(approvalChangesOf('POST', `${P}/approvals/bulk-approve`, {})).toEqual([]);
  });

  it.each([
    ['/approvals/away/a1/approve', 'DECIDED'],
    ['/approvals/away/a1/reject', 'DECIDED'],
    ['/approvals/away/a1/reopen', 'REOPENED'],
    // The type is read in any case, as the controller reads it.
    ['/approvals/AWAY/a1/Approve', 'DECIDED'],
  ])('4.0: POST %s is away time %s', (path, action) => {
    expect(approvalChangesOf('POST', `${P}${path}`, null)).toEqual([
      { what: 'AWAY', id: 'a1', action },
    ]);
  });

  it('4.0: bulk approve names away time, and nothing of a type it does not know', () => {
    expect(
      approvalChangesOf('POST', `${P}/approvals/bulk-approve`, {
        approved: [
          { type: 'away', id: 'a1' },
          { type: 'Meeting', id: 'm1' },
          { type: 'lunch', id: 'x1' },
        ],
        skipped: [],
      }),
    ).toEqual([
      { what: 'AWAY', id: 'a1', action: 'DECIDED' },
      { what: 'MEETING', id: 'm1', action: 'DECIDED' },
    ]);
  });

  it('a break ended that still waits has changed, whoever hears it next must re-read it', () => {
    const answer = (approvalStatus: string) => ({
      ended: true,
      record: { id: 'b1', approvalStatus },
    });
    expect(approvalChangesOf('POST', `${P}/breaks/end`, answer('PENDING'))).toEqual([
      { what: 'BREAK', id: 'b1', action: 'UPDATED' },
    ]);
    expect(approvalChangesOf('POST', `${P}/breaks/end`, answer('APPROVED'))).toEqual([]);
    expect(approvalChangesOf('POST', `${P}/breaks/end`, answer('NOT_REQUIRED'))).toEqual([]);
    expect(approvalChangesOf('POST', `${P}/breaks/end`, { ended: true, record: null })).toEqual([]);
    expect(approvalChangesOf('POST', `${P}/breaks/end`, null)).toEqual([]);
  });

  it('a live meeting started shows in the lists at once, and a push waits for its end', () => {
    expect(
      approvalChangesOf('POST', `${P}/meetings/start`, {
        meeting: { id: 'm1' },
        presence: { status: 'MEETING' },
      }),
    ).toEqual([{ what: 'MEETING', id: 'm1', action: 'UPDATED' }]);
    expect(approvalChangesOf('POST', `${P}/meetings/start`, {})).toEqual([]);
    expect(
      approvalChangesOf('POST', `${P}/meetings/status/start`, { meeting: { id: 'm2' } }),
    ).toEqual([]);
  });

  it('a live meeting discarded on ending leaves the lists; one that ended is its own event', () => {
    expect(
      approvalChangesOf('POST', `${P}/meetings/m1/end`, { meeting: null, discarded: true }),
    ).toEqual([{ what: 'MEETING', id: 'm1', action: 'UPDATED' }]);
    expect(
      approvalChangesOf('POST', `${P}/meetings/m1/end`, {
        meeting: { id: 'm1' },
        discarded: false,
      }),
    ).toEqual([]);
    // A status meeting needs no approval and has no id in its path (D-20).
    expect(
      approvalChangesOf('POST', `${P}/meetings/status/end`, { meeting: null, discarded: true }),
    ).toEqual([]);
  });

  it('ignores reads, previews and everything else', () => {
    for (const [method, path] of [
      ['GET', '/approvals'],
      ['GET', '/leave/requests'],
      ['GET', '/leave/requests/l1'],
      ['POST', '/leave/preview'],
      ['POST', '/wfh/preview'],
      ['POST', '/leave/adjustments'],
      ['POST', '/wfh/schedules'],
      ['POST', '/breaks/start'],
      ['POST', '/breaks/skip'],
      ['POST', '/activity/start-day'],
      ['POST', '/approvals/shift/x/approve'],
    ]) {
      expect(approvalChangesOf(method, `${P}${path}`, { id: 'n1' })).toEqual([]);
    }
  });
});

describe('ApprovalChangeInterceptor', () => {
  function run(path: string, answer: () => Observable<unknown>, type = 'http', method = 'POST') {
    const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const context = {
      getType: () => type,
      switchToHttp: () => ({ getRequest: () => ({ method, path }) }),
    } as never;
    const result = new ApprovalChangeInterceptor(events).intercept(context, {
      handle: answer,
    });
    return { events, result };
  }

  it('publishes after a successful request', async () => {
    const { events, result } = run(`${P}/leave/requests`, () =>
      of({ data: { id: 'l1', status: 'PENDING' } }),
    );
    await lastValueFrom(result);
    expect(events.publish).toHaveBeenCalledTimes(1);
    const [name, event] = events.publish.mock.calls[0];
    expect(name).toBe(ApprovalChangedEvent.eventName);
    expect(event).toMatchObject({ what: 'LEAVE', id: 'l1', action: 'CREATED' });
  });

  it('publishes nothing when the request was refused', async () => {
    const { events, result } = run(`${P}/approvals/break/b1/approve`, () =>
      throwError(() => new Error('refused')),
    );
    await expect(lastValueFrom(result)).rejects.toThrow('refused');
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('leaves sockets and reads alone', async () => {
    const socket = run(`${P}/approvals/break/b1/approve`, () => of({}), 'ws');
    await lastValueFrom(socket.result);
    expect(socket.events.publish).not.toHaveBeenCalled();
    const read = run(`${P}/approvals/break/b1/approve`, () => of({}), 'http', 'GET');
    await lastValueFrom(read.result);
    expect(read.events.publish).not.toHaveBeenCalled();
  });
});
