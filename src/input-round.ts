import { assertInputResponse } from "./input.js";
import { normalizeJsonValue } from "./json.js";
import type { InputRequests, InputResponses } from "./types.js";

/**
 * The merge rule for one `tasks/update`, as a pure function.
 *
 * It lives apart from the lifecycle because it is the sharpest algorithm in the
 * package and the one every audit has found something in — prototype-named
 * keys, partial rounds, duplicate delivery, a decision surviving a lost
 * compare-and-swap. As a function of three values it can be tested directly,
 * with no store, no engine and no clock, which is the only way a table of cases
 * reads as the rule it is enforcing.
 *
 * It touches no I/O and no instance state. It does throw: a response that does
 * not match the request it answers is the caller's error, and rejecting it
 * before anything is committed is the point.
 */

export interface InputRoundMerge {
  /** Every response accepted so far, including the ones this update added. */
  readonly responses: InputResponses;
  /** True once every outstanding key has an answer. */
  readonly complete: boolean;
}

/**
 * Returns `undefined` when nothing applied, which the caller treats as "no
 * write" rather than an empty one.
 *
 * Keys that are not outstanding, or already answered, are **ignored** — the
 * extension asks a server to do exactly that, including for keys it never
 * issued and keys whose request was superseded. Ignoring an already-answered
 * key is also what makes a duplicate delivery a no-op instead of an overwrite.
 */
export function mergeInputResponses(
  outstanding: InputRequests,
  existing: InputResponses | undefined,
  incoming: Record<string, unknown>,
): InputRoundMerge | undefined {
  // A null-prototype target, because input keys are arbitrary strings and
  // `"toString" in merged` would otherwise be true through the prototype
  // chain — reporting a key as answered that nobody answered.
  const merged = Object.assign(
    Object.create(null) as Record<string, unknown>,
    existing,
  );

  let applied = 0;
  for (const [key, response] of Object.entries(incoming)) {
    if (!Object.hasOwn(outstanding, key) || Object.hasOwn(merged, key)) {
      continue;
    }
    assertInputResponse(outstanding[key]!, response, key);
    merged[key] = normalizeJsonValue(
      response,
      `Input response ${JSON.stringify(key)}`,
    ) as unknown as InputResponses[string];
    applied += 1;
  }

  if (applied === 0) return undefined;

  return {
    responses: { ...merged } as InputResponses,
    complete: Object.keys(outstanding).every((key) =>
      Object.hasOwn(merged, key),
    ),
  };
}
