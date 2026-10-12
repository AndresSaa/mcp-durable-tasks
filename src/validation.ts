// Boundary checks for the scalar task fields a caller supplies. The stable
// 2026-07-28 schema types `ttlMs` and `pollIntervalMs` as integer milliseconds
// within the safe-integer range and `statusMessage` as a string; a value that
// slipped past here would be stored and then emitted on every `tasks/get` as a
// result the schema rejects. Records already in a store are not re-checked:
// see docs/contract.md#wire-contract.

export function assertTtlMs(value: number | null, source: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError(
      `${source} must be null or a safe integer number of milliseconds greater than 0`,
    );
  }
}

export function assertPollIntervalMs(value: number, source: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `${source} must be a safe integer number of milliseconds`,
    );
  }
}

/** The longest delay `setTimeout`/`setInterval` honour; Node clamps beyond. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * `sweepIntervalMs`: `null`/`undefined` disable the sweeper; anything else
 * must be a whole number of milliseconds a timer can actually wait. Node
 * coerces 0, negatives, `NaN` and values above the timer limit to 1 ms, which
 * would turn housekeeping into a busy loop.
 */
export function assertSweepIntervalMs(value: unknown): void {
  if (value === null || value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_TIMER_MS
  ) {
    throw new TypeError(
      `sweepIntervalMs must be null or an integer number of milliseconds from 1 to ${MAX_TIMER_MS}`,
    );
  }
}

/**
 * `compactEvery`: `null` disables automatic compaction; anything else must be
 * a safe integer of at least 1. `NaN` would silently disable it, and 0 or a
 * negative count would compact after every mutation.
 */
export function assertCompactEvery(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(
      "compactEvery must be null or a safe integer greater than 0",
    );
  }
}

/** Only reachable from untyped JavaScript; TypeScript already requires it. */
export function assertStatusMessage(value: string, source: string): void {
  if (typeof value !== "string") {
    throw new TypeError(`${source} must be a string`);
  }
}
