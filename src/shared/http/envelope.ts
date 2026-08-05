export const ENVELOPE = Symbol('ENVELOPE');

export interface EnvelopePayload<T = unknown> {
  [ENVELOPE]: true;
  data: T;
  extra?: Record<string, unknown>;
}

export function envelope<T>(data: T, extra?: Record<string, unknown>): EnvelopePayload<T> {
  return { [ENVELOPE]: true, data, extra };
}

export function isEnvelope(value: unknown): value is EnvelopePayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[ENVELOPE] === true
  );
}
