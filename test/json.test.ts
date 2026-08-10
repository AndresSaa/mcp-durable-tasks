import { describe, expect, it } from "vitest";
import { isJsonValue, normalizeJsonValue } from "../src/json.js";

describe("JSON canonicalisation", () => {
  it("normalises signed zero recursively without rejecting it", () => {
    const value = {
      scalar: -0,
      nested: [-0, { negative: -0 }],
    };

    expect(isJsonValue(value)).toBe(true);
    const normalized = normalizeJsonValue(value, "value") as typeof value;
    expect(Object.is(normalized.scalar, 0)).toBe(true);
    expect(Object.is(normalized.nested[0], 0)).toBe(true);
    expect(
      Object.is((normalized.nested[1] as { negative: number }).negative, 0),
    ).toBe(true);
  });

  it("preserves every other accepted finite number across JSON encoding", () => {
    const numbers = [
      0,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      -1.5,
      1.5,
    ];

    for (const value of numbers) {
      expect(isJsonValue(value)).toBe(true);
      const normalized = normalizeJsonValue(value, "number");
      const roundTripped = JSON.parse(JSON.stringify(normalized)) as number;
      expect(Object.is(normalized, value)).toBe(true);
      expect(Object.is(roundTripped, value)).toBe(true);
    }
  });

  it("retains prototype-named keys as ordinary JSON data", () => {
    const value = JSON.parse('{"__proto__":{"signedZero":-0}}') as Record<
      string,
      { signedZero: number }
    >;
    const normalized = normalizeJsonValue(value, "value") as typeof value;

    expect(Object.hasOwn(normalized, "__proto__")).toBe(true);
    expect(Object.is(normalized.__proto__.signedZero, 0)).toBe(true);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
  });
});
