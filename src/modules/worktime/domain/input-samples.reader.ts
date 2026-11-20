import { InputSample } from './input-activity';

export const INPUT_SAMPLES_READER = Symbol('INPUT_SAMPLES_READER');

/** One person's span of time to read samples for, under a caller-chosen key. */
export interface SampleWindow {
  key: string;
  userId: string;
  from: Date;
  to: Date;
}

/**
 * The agent's activity samples (keyboard and mouse state) for spans of time, in
 * one query: what a manager sees as active and idle is worked out from these.
 */
export interface InputSamplesReader {
  /** Samples with `at` in [from, to) per window key, oldest first. */
  samplesInWindows(windows: SampleWindow[]): Promise<Map<string, InputSample[]>>;
}
