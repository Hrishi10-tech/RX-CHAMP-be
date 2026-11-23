import { DevicesController } from './devices.controller';

const me = { id: 'u1' } as never;
const TOKEN = 'x'.repeat(163);

function setup() {
  const push = { removeDevices: jest.fn().mockResolvedValue(1), registerDevice: jest.fn() };
  return { controller: new DevicesController(push as never), push };
}

describe('DevicesController: DELETE /devices/push-token (3.6)', () => {
  it.each([
    ['no body', undefined],
    ['an empty body', {}],
  ])('%s forgets every phone', async (_name, raw) => {
    const { controller, push } = setup();
    await controller.remove(me, {} as never, { body: raw } as never);
    expect(push.removeDevices).toHaveBeenCalledWith('u1', undefined);
  });

  it('a token named forgets that phone', async () => {
    const { controller, push } = setup();
    await controller.remove(me, { token: TOKEN } as never, { body: { token: TOKEN } } as never);
    expect(push.removeDevices).toHaveBeenCalledWith('u1', TOKEN);
  });

  it.each([
    ['an array', []],
    ['an array holding the token', [{ token: TOKEN }]],
    ['a misspelt field, which the pipe would drop', { tokens: TOKEN }],
    ['the token and something else', { token: TOKEN, all: true }],
  ])('%s is refused, not read as every phone', async (_name, raw) => {
    const { controller, push } = setup();
    await expect(controller.remove(me, {} as never, { body: raw } as never)).rejects.toMatchObject({
      status: 400,
    });
    expect(push.removeDevices).not.toHaveBeenCalled();
  });
});
