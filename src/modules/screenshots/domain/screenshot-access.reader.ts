import { ManagerLookupReader } from '@shared/rbac/manager-lookup.reader';

export const SCREENSHOT_ACCESS_READER = Symbol('SCREENSHOT_ACCESS_READER');

export type ScreenshotAccessReader = ManagerLookupReader;
