import { RequestMethod, type Type } from '@nestjs/common';
import { INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readFileSync, readdirSync } from 'fs';
import { join, relative, resolve, sep } from 'path';
import { AvatarsController, MyAvatarController, UserAvatarController } from './avatars.controller';

const SRC = resolve(__dirname, '../../..');

type Handler = (...args: unknown[]) => unknown;

function handlersOf(controller: Type<unknown>): Handler[] {
  const proto = controller.prototype as Record<string, Handler>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor')
    .map((name) => proto[name])
    .filter((handler) => Reflect.getMetadata(METHOD_METADATA, handler) !== undefined);
}

function routesOf(controller: Type<unknown>): string[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  return handlersOf(controller).map((handler) => {
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as string;
    return `${RequestMethod[method]} ${path === '/' ? base : `${base}/${path}`}`;
  });
}

const controllerFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(path);
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });

const inSource = (pattern: RegExp): string[] =>
  controllerFiles(SRC)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path).split(sep).join('/'));

/** Brief 1.9: presets only, no profile-picture or avatar upload on any platform or API. */
describe('no avatar upload path', () => {
  it('the avatar routes are exactly these, and none of them takes a file', () => {
    const controllers = [AvatarsController, MyAvatarController, UserAvatarController];
    expect(controllers.flatMap(routesOf).sort()).toEqual([
      'DELETE me/avatar',
      'GET avatars/files/:size/:id.webp',
      'GET avatars/manifest',
      'GET me/avatar',
      'POST users/:id/avatar/reset',
      'PUT me/avatar',
    ]);
    for (const controller of controllers) {
      expect(Reflect.getMetadata(INTERCEPTORS_METADATA, controller)).toBeUndefined();
      for (const handler of handlersOf(controller)) {
        expect(Reflect.getMetadata(INTERCEPTORS_METADATA, handler)).toBeUndefined();
      }
    }
  });

  it('no other controller names an avatar, a photo or a picture in a route', () => {
    const route = /@(Controller|Get|Post|Put|Patch|Delete)\(\s*['"`][^'"`]*(avatar|photo|picture)/i;
    expect(inSource(route)).toEqual(['modules/avatars/presentation/avatars.controller.ts']);
  });

  // Whoever adds a file route (message images in 2.1) lists it here, knowing it is not this.
  // 4.0: no route takes a file at all; captures go straight to S3 by a presigned POST.
  it('no route takes a file', () => {
    const upload = /\b(File|Files|FileFields|AnyFiles)Interceptor\b/;
    expect(inSource(upload)).toEqual([]);
  });
});
