import { describe, expect, it } from "vitest";
import { assertInputResponse, isInputRequest } from "../src/input.js";
import type { InputRequest } from "../src/index.js";

// This is the validation that replaces what the published JSON Schema lost.
// `InputRequest` and `InputResponse` are declared upstream as unions of SDK
// types, those imports do not resolve during generation, and both degrade to
// an unconstrained `anyOf` — so a validator built on schema.json accepts
// anything (docs/contract.md, conformance question A8). The runtime enforces the real shapes, which
// makes this file the only thing standing between a malformed sampling
// request and a client that cannot fulfil it.
//
// Table-driven on purpose: what matters is which shapes are refused, and a
// list of them reads as the specification it is enforcing.

const TEXT = { type: "text" as const, text: "hello" };

const SAMPLING: InputRequest = {
  method: "sampling/createMessage",
  params: {
    messages: [{ role: "user", content: TEXT }],
    maxTokens: 512,
  },
};

const ELICIT: InputRequest = {
  method: "elicitation/create",
  params: {
    message: "Continue?",
    requestedSchema: {
      type: "object",
      properties: { confirm: { type: "boolean" } },
    },
  },
};

function sampling(params: Record<string, unknown>) {
  return { method: "sampling/createMessage", params };
}

function elicit(params: Record<string, unknown>) {
  return { method: "elicitation/create", params };
}

describe("what counts as an input request", () => {
  it.each([
    ["a minimal roots request", { method: "roots/list" }],
    ["roots with an empty params object", { method: "roots/list", params: {} }],
    ["a sampling request", SAMPLING],
    ["an elicitation request", ELICIT],
    [
      "sampling with an array of content blocks",
      sampling({
        messages: [{ role: "assistant", content: [TEXT, TEXT] }],
        maxTokens: 1,
      }),
    ],
    [
      "sampling with model preferences",
      sampling({
        messages: [{ role: "user", content: TEXT }],
        maxTokens: 8,
        modelPreferences: { costPriority: 0.5, hints: [{ name: "sonnet" }] },
      }),
    ],
    [
      "sampling with the SDK's integer zero token limit",
      sampling({
        messages: [{ role: "user", content: TEXT }],
        maxTokens: 0,
      }),
    ],
    [
      "sampling with task-aware tool metadata",
      sampling({
        messages: [{ role: "user", content: TEXT }],
        maxTokens: 8,
        tools: [
          {
            name: "weather",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            execution: { taskSupport: "optional" },
          },
        ],
      }),
    ],
    [
      "elicitation in url mode",
      elicit({
        message: "Sign in",
        mode: "url",
        elicitationId: "sign-in-1",
        url: "https://example.test",
      }),
    ],
  ])("accepts %s", (_name, value) => {
    expect(isInputRequest(value)).toBe(true);
  });

  it.each([
    ["a method MCP does not define", { method: "tools/call" }],
    ["a bare object", {}],
    ["null", null],
    ["an array", []],
    ["a string", "roots/list"],
    ["roots with non-object params", { method: "roots/list", params: 42 }],
    ["sampling with no params", { method: "sampling/createMessage" }],
    ["sampling with no messages", sampling({ maxTokens: 1 })],
    [
      "sampling with no maxTokens",
      sampling({ messages: [{ role: "user", content: TEXT }] }),
    ],
    [
      "sampling with fractional maxTokens",
      sampling({ messages: [{ role: "user", content: TEXT }], maxTokens: 1.5 }),
    ],
    [
      "sampling with an unknown role",
      sampling({ messages: [{ role: "system", content: TEXT }], maxTokens: 1 }),
    ],
    [
      "sampling whose content block has no type",
      sampling({ messages: [{ role: "user", content: {} }], maxTokens: 1 }),
    ],
    [
      "sampling whose text block has no text",
      sampling({
        messages: [{ role: "user", content: { type: "text" } }],
        maxTokens: 1,
      }),
    ],
    [
      "sampling whose binary content is not Base64",
      sampling({
        messages: [
          {
            role: "user",
            content: { type: "image", data: "not base64!", mimeType: "x" },
          },
        ],
        maxTokens: 1,
      }),
    ],
    [
      "sampling whose tool output schema is not rooted at object",
      sampling({
        messages: [{ role: "user", content: TEXT }],
        maxTokens: 1,
        tools: [
          {
            name: "bad",
            inputSchema: { type: "object" },
            outputSchema: { type: "string" },
          },
        ],
      }),
    ],
    ["elicitation with no message", elicit({ requestedSchema: {} })],
    ["elicitation with no schema", elicit({ message: "Continue?" })],
    [
      "elicitation whose schema is not an object schema",
      elicit({
        message: "Continue?",
        requestedSchema: { type: "string", properties: {} },
      }),
    ],
    [
      "elicitation in url mode with no url",
      elicit({ message: "Sign in", mode: "url", elicitationId: "id" }),
    ],
    [
      "elicitation in url mode with no id",
      elicit({ message: "Sign in", mode: "url", url: "https://example.test" }),
    ],
    [
      "elicitation in url mode with an invalid URL",
      elicit({
        message: "Sign in",
        mode: "url",
        elicitationId: "id",
        url: "not a URL",
      }),
    ],
    [
      "elicitation in an unknown mode",
      elicit({ message: "?", mode: "telepathy" }),
    ],
  ])("refuses %s", (_name, value) => {
    expect(isInputRequest(value)).toBe(false);
  });
});

describe("what counts as a response to each request", () => {
  const ok = (request: InputRequest, response: unknown) =>
    expect(() => assertInputResponse(request, response, "k")).not.toThrow();
  const refused = (request: InputRequest, response: unknown) =>
    expect(() => assertInputResponse(request, response, "k")).toThrow(
      TypeError,
    );

  it("accepts a well-formed roots result", () => {
    ok({ method: "roots/list" }, { roots: [] });
    ok(
      { method: "roots/list" },
      { roots: [{ uri: "file:///a", name: "a" }, { uri: "file:///b" }] },
    );
  });

  it.each([
    ["a number", 42],
    ["null", null],
    ["an array", []],
    ["no roots key", {}],
    ["roots that is not an array", { roots: {} }],
    ["a root with no uri", { roots: [{ name: "a" }] }],
    ["a root whose name is not a string", { roots: [{ uri: "x", name: 1 }] }],
    ["a root whose URI is not file://", { roots: [{ uri: "https://x" }] }],
  ])("refuses %s as a roots result", (_name, response) => {
    refused({ method: "roots/list" }, response);
  });

  it("accepts a well-formed sampling result", () => {
    ok(SAMPLING, { model: "m", role: "assistant", content: TEXT });
  });

  it.each([
    ["no model", { role: "assistant", content: TEXT }],
    ["a non-string model", { model: 1, role: "assistant", content: TEXT }],
    ["an unknown role", { model: "m", role: "system", content: TEXT }],
    ["no content", { model: "m", role: "assistant" }],
    [
      "a content block with no type",
      { model: "m", role: "assistant", content: {} },
    ],
    [
      "non-Base64 binary content",
      {
        model: "m",
        role: "assistant",
        content: { type: "audio", data: "not base64!", mimeType: "audio/wav" },
      },
    ],
    [
      "non-object structured tool content",
      {
        model: "m",
        role: "assistant",
        content: {
          type: "tool_result",
          toolUseId: "call-1",
          content: [],
          structuredContent: [],
        },
      },
    ],
  ])("refuses a sampling result with %s", (_name, response) => {
    refused(SAMPLING, response);
  });

  it("accepts every legal elicitation action", () => {
    ok(ELICIT, { action: "accept", content: { confirm: true } });
    ok(ELICIT, { action: "decline" });
    ok(ELICIT, { action: "cancel" });
  });

  it.each([
    ["an unknown action", { action: "maybe" }],
    ["no action", { content: {} }],
    // Elicitation content is primitives and string arrays only, which is the
    // narrowing the earlier audit found missing.
    [
      "a nested object as content",
      { action: "accept", content: { a: { b: 1 } } },
    ],
    [
      "an array of objects as content",
      { action: "accept", content: { a: [{}] } },
    ],
    ["null as content", { action: "accept", content: null }],
  ])("refuses an elicitation result with %s", (_name, response) => {
    refused(ELICIT, response);
  });

  it("names the key it rejected, so a mixed update says which one failed", () => {
    expect(() =>
      assertInputResponse({ method: "roots/list" }, 42, "the-key"),
    ).toThrow(/"the-key"/);
  });
});
