// Boundary checks for the scalar task fields a caller supplies. The stable
// 2026-07-28 schema types `ttlMs` and `pollIntervalMs` as integer milliseconds
// within the safe-integer range; a value that
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
