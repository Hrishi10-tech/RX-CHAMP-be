const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export function parseDurationMs(input: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration: "${input}" (expected e.g. 15m, 7d, 30s, 12h)`);
  }
  const [, value, unit] = match;
  return Number(value) * UNIT_MS[unit];
}

/** "9h 00m", "45m", "0m" (whole minutes, rounded down); a negative takes a real minus sign. */
export function formatDuration(sec: number): string {
  const sign = sec < 0 ? '−' : '';
  const total = Math.floor(Math.abs(sec) / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${sign}${h}h ${String(m).padStart(2, '0')}m` : `${sign}${m}m`;
}
