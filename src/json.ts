import type { JsonObject, JsonValue } from "./types.js";

/** True only for values whose structure and values survive a JSON round-trip. */
export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueAt(value, new Set<object>());
}

export function assertJsonObject(
  value: unknown,
  what: string,
): asserts value is JsonObject {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !isJsonValue(value)
  ) {
    throw new TypeError(`${what} must be a plain JSON object`);
  }
}

/**
 * Validates and detaches a JSON value while canonicalising the one JavaScript
 * number whose identity does not survive JSON encoding: `-0` becomes `0`.
 *
 * Escaping changes the encoded spelling of some strings but parsing restores
 * the same string. Among finite numbers, `-0` is the only value accepted by
 * `isJsonValue()` for which `Object.is(value, JSON.parse(JSON.stringify(value)))`
 * is false. Canonicalising it here keeps memory, WAL replay and returned worker
 * input on one representation.
 */
export function normalizeJsonValue(value: unknown, what: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError(`${what} must be a pure JSON value`);
  }
  return normalizeJsonValueAt(value);
}

export function normalizeJsonObject(value: unknown, what: string): JsonObject {
  assertJsonObject(value, what);
  return normalizeJsonValueAt(value) as JsonObject;
}

function isJsonValueAt(value: unknown, stack: Set<object>): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (stack.has(value)) return false;

  stack.add(value);
  try {
    if (Array.isArray(value)) return isJsonArray(value, stack);

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isJsonValueAt(descriptor.value, stack)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    stack.delete(value);
  }
}

function isJsonArray(value: unknown[], stack: Set<object>): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !isJsonValueAt(descriptor.value, stack)
    ) {
      return false;
    }
  }
  return true;
}

function normalizeJsonValueAt(value: JsonValue): JsonValue {
  if (typeof value === "number") return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalizeJsonValueAt);
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Define the property instead of assigning so `__proto__` remains an
      // ordinary JSON key rather than invoking Object.prototype's setter.
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: normalizeJsonValueAt(entry),
        writable: true,
      });
    }
    return normalized;
  }
  return value;
}
