export const PLATFORM_NAME = 'TraneNexia';
export const PLUGIN_NAME = 'homebridge-trane-nexia';

export const TRANE_BASE_URL = 'https://www.tranehome.com/mobile/';
export const NEXIA_BASE_URL = 'https://www.mynexia.com/mobile/';
export const ASAIR_BASE_URL = 'https://asairhome.com/mobile/';

export const DEFAULT_POLL_SECONDS = 30;
export const MIN_POLL_SECONDS = 10;
export const MAX_POLL_SECONDS = 600;

/** Turns whatever is in `pollInterval` into a safe number of seconds. A hand-edited config can hold
 *  "30s", NaN or a huge number; `setTimeout` fires after 1 ms for NaN and for anything above 2^31-1 ms,
 *  which would hammer the vendor cloud in a tight loop. */
export function normalizePollSeconds(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_POLL_SECONDS;
  const n = Number(raw);
  if (Number.isNaN(n)) return DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, n));
}

export const MAX_BACKOFF_MS = 10 * 60 * 1000;

/** Delay before the next poll. Normal cadence while healthy; after consecutive failures it doubles each
 *  time up to ten minutes (or the poll interval, if that is longer), so a vendor outage or a revoked key
 *  isn't hit every 30 seconds forever. An authentication failure can't fix itself, so it goes straight to the cap. */
export function nextPollDelayMs(pollMs: number, consecutiveFailures: number, authFailure = false): number {
  if (consecutiveFailures <= 0) return pollMs;
  const cap = Math.max(pollMs, MAX_BACKOFF_MS);
  if (authFailure) return cap;
  return Math.min(cap, pollMs * 2 ** Math.min(consecutiveFailures, 10));
}

export const BRANDS = ['trane', 'nexia', 'asair'] as const;
export type BrandName = typeof BRANDS[number];

export function baseUrlFor(brand: BrandName): string {
  switch (brand) {
    case 'trane': return TRANE_BASE_URL;
    case 'nexia': return NEXIA_BASE_URL;
    case 'asair': return ASAIR_BASE_URL;
  }
}
