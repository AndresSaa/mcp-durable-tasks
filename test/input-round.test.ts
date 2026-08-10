import { describe, expect, it } from "vitest";
import { mergeInputResponses } from "../src/input-round.js";
import type { InputRequests, InputResponses } from "../src/index.js";

// The merge rule, tested as the pure function it is: no store, no engine, no
// clock. Every bug three audits found in this algorithm is a row here.

const ROOTS = { method: "roots/list" } as const;
const answer = (extra: Record<string, unknown> = {}) => ({
  roots: [],
  ...extra,
});

const outstanding = (...keys: string[]): InputRequests =>
  Object.fromEntries(keys.map((key) => [key, ROOTS])) as InputRequests;

describe("what an update applies", () => {
  it("applies an outstanding key and reports the round incomplete", () => {
    const merge = mergeInputResponses(outstanding("a", "b"), undefined, {
      a: answer(),
    });
    expect(merge?.complete).toBe(false);
    expect(Object.keys(merge!.responses)).toEqual(["a"]);
  });

  it("reports complete once the last key lands", () => {
    const merge = mergeInputResponses(
      outstanding("a", "b"),
      { a: answer() } as unknown as InputResponses,
      { b: answer() },
    );
    expect(merge?.complete).toBe(true);
  });

  it("returns undefined when nothing applied, so the caller writes nothing", () => {
    expect(
      mergeInputResponses(outstanding("a"), undefined, { ghost: answer() }),
    ).toBeUndefined();
  });
});

describe("what an update ignores", () => {
  it("ignores a key that was never issued, and keeps the good ones", () => {
    const merge = mergeInputResponses(outstanding("a"), undefined, {
      ghost: answer(),
      a: answer({ marker: 1 }),
    });
    expect(Object.keys(merge!.responses)).toEqual(["a"]);
  });

  it("treats a repeated answer as a no-op rather than an overwrite", () => {
    const merge = mergeInputResponses(
      outstanding("a", "b"),
      { a: answer({ attempt: 1 }) } as unknown as InputResponses,
      { a: answer({ attempt: 2 }) },
    );
    // Only `a` was offered and it was already answered, so nothing applies.
    expect(merge).toBeUndefined();
  });
});

describe("prototype-named keys", () => {
  // `"toString" in merged` is true through the prototype chain, which once
  // reported a key as answered that nobody had answered.
  it.each(["toString", "constructor", "hasOwnProperty", "__proto__"])(
    "does not consider %s answered until it actually is",
    (key) => {
      const partial = mergeInputResponses(outstanding("a", key), undefined, {
        a: answer(),
      });
      expect(partial?.complete).toBe(false);

      const full = mergeInputResponses(
        outstanding("a", key),
        partial!.responses,
        { [key]: answer() },
      );
      expect(full?.complete).toBe(true);
      expect(Object.hasOwn(full!.responses, key)).toBe(true);
    },
  );

  it("still refuses a prototype-named key that was never outstanding", () => {
    expect(
      mergeInputResponses(outstanding("a"), undefined, {
        toString: answer(),
      }),
    ).toBeUndefined();
  });
});

describe("validation happens before anything is returned", () => {
  it("rejects a response that does not match its request", () => {
    expect(() =>
      mergeInputResponses(outstanding("a"), undefined, { a: 42 }),
    ).toThrow(TypeError);
  });

  it("names the offending key", () => {
    expect(() =>
      mergeInputResponses(outstanding("the-key"), undefined, {
        "the-key": 42,
      }),
    ).toThrow(/"the-key"/);
  });
});
