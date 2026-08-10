export function assertTtlMs(value: number | null, source: string): void {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
  ) {
    throw new TypeError(
      `${source} must be null or a finite number greater than 0`,
    );
  }
}
