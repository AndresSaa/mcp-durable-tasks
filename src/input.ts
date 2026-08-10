import type { InputRequest, InputResponse } from "./types.js";
import { isJsonValue } from "./json.js";

// Runtime mirror of the zero-dependency input union imported by ext-tasks.
// Authority: @modelcontextprotocol/sdk@1.30.0 src/types.ts, not the generated
// ext-tasks JSON Schema (which loses these imported shapes).

const INPUT_REQUEST_METHODS: ReadonlySet<string> = new Set([
  "sampling/createMessage",
  "roots/list",
  "elicitation/create",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBase64(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    atob(value);
    return true;
  } catch {
    return false;
  }
}

function isUrl(value: unknown): value is string {
  return typeof value === "string" && URL.canParse(value);
}

function isIsoDateTimeWithOffset(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isOptional(
  value: Record<string, unknown>,
  key: string,
  predicate: (candidate: unknown) => boolean,
): boolean {
  return value[key] === undefined || predicate(value[key]);
}

function isAnnotations(value: unknown): boolean {
  return (
    isObject(value) &&
    isOptional(
      value,
      "audience",
      (audience) =>
        Array.isArray(audience) &&
        audience.every((role) => role === "user" || role === "assistant"),
    ) &&
    isOptional(
      value,
      "priority",
      (priority) => isFiniteNumber(priority) && priority >= 0 && priority <= 1,
    ) &&
    isOptional(value, "lastModified", isIsoDateTimeWithOffset)
  );
}

function hasContentMetadata(value: Record<string, unknown>): boolean {
  return (
    isOptional(value, "annotations", isAnnotations) &&
    isOptional(value, "_meta", isObject)
  );
}

function isIcon(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.src === "string" &&
    isOptional(value, "mimeType", (entry) => typeof entry === "string") &&
    isOptional(value, "sizes", isStringArray) &&
    isOptional(value, "theme", (entry) => entry === "light" || entry === "dark")
  );
}

function isResourceLink(value: Record<string, unknown>): boolean {
  return (
    typeof value.name === "string" &&
    typeof value.uri === "string" &&
    isOptional(value, "title", (entry) => typeof entry === "string") &&
    isOptional(value, "description", (entry) => typeof entry === "string") &&
    isOptional(value, "mimeType", (entry) => typeof entry === "string") &&
    isOptional(value, "size", isFiniteNumber) &&
    isOptional(
      value,
      "icons",
      (entry) => Array.isArray(entry) && entry.every(isIcon),
    ) &&
    hasContentMetadata(value)
  );
}

function isEmbeddedResource(value: Record<string, unknown>): boolean {
  if (!isObject(value.resource) || typeof value.resource.uri !== "string") {
    return false;
  }
  const resource = value.resource;
  return (
    (typeof resource.text === "string" || isBase64(resource.blob)) &&
    isOptional(resource, "mimeType", (entry) => typeof entry === "string") &&
    isOptional(resource, "_meta", isObject) &&
    hasContentMetadata(value)
  );
}

function isToolResultContentBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string" && hasContentMetadata(value);
    case "image":
    case "audio":
      return (
        isBase64(value.data) &&
        typeof value.mimeType === "string" &&
        hasContentMetadata(value)
      );
    case "resource_link":
      return isResourceLink(value);
    case "resource":
      return isEmbeddedResource(value);
    default:
      return false;
  }
}

function isSamplingContentBlock(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (isToolResultContentBlock(value)) return true;
  if (value.type === "tool_use") {
    return (
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      isObject(value.input) &&
      isOptional(value, "_meta", isObject)
    );
  }
  if (value.type === "tool_result") {
    return (
      typeof value.toolUseId === "string" &&
      Array.isArray(value.content) &&
      value.content.every(isToolResultContentBlock) &&
      isOptional(value, "structuredContent", isObject) &&
      isOptional(value, "isError", (entry) => typeof entry === "boolean") &&
      isOptional(value, "_meta", isObject)
    );
  }
  return false;
}

function isSamplingContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSamplingContentBlock);
  return isSamplingContentBlock(value);
}

function isSamplingMessage(value: unknown): boolean {
  return (
    isObject(value) &&
    (value.role === "user" || value.role === "assistant") &&
    isSamplingContent(value.content) &&
    isOptional(value, "_meta", isObject)
  );
}

function isModelPreferences(value: unknown): boolean {
  if (!isObject(value)) return false;
  const isPriority = (entry: unknown) =>
    isFiniteNumber(entry) && entry >= 0 && entry <= 1;
  return (
    isOptional(
      value,
      "hints",
      (entry) =>
        Array.isArray(entry) &&
        entry.every(
          (hint) =>
            isObject(hint) &&
            isOptional(hint, "name", (name) => typeof name === "string"),
        ),
    ) &&
    isOptional(value, "costPriority", isPriority) &&
    isOptional(value, "speedPriority", isPriority) &&
    isOptional(value, "intelligencePriority", isPriority)
  );
}

function isToolAnnotations(value: unknown): boolean {
  return (
    isObject(value) &&
    isOptional(value, "title", (entry) => typeof entry === "string") &&
    [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ].every((key) =>
      isOptional(value, key, (entry) => typeof entry === "boolean"),
    )
  );
}

function isSamplingTool(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    isObject(value.inputSchema) &&
    value.inputSchema.type === "object" &&
    isOptional(value, "title", (entry) => typeof entry === "string") &&
    isOptional(value, "description", (entry) => typeof entry === "string") &&
    isOptional(
      value,
      "outputSchema",
      (entry) => isObject(entry) && entry.type === "object",
    ) &&
    isOptional(value, "annotations", isToolAnnotations) &&
    isOptional(
      value,
      "icons",
      (entry) => Array.isArray(entry) && entry.every(isIcon),
    ) &&
    isOptional(
      value,
      "execution",
      (entry) =>
        isObject(entry) &&
        isOptional(
          entry,
          "taskSupport",
          (support) =>
            support === "required" ||
            support === "optional" ||
            support === "forbidden",
        ),
    ) &&
    isOptional(value, "_meta", isObject)
  );
}

function isSamplingRequest(value: Record<string, unknown>): boolean {
  if (!isObject(value.params)) return false;
  const params = value.params;
  return (
    Array.isArray(params.messages) &&
    params.messages.every(isSamplingMessage) &&
    Number.isInteger(params.maxTokens) &&
    isOptional(params, "modelPreferences", isModelPreferences) &&
    isOptional(params, "systemPrompt", (entry) => typeof entry === "string") &&
    isOptional(
      params,
      "includeContext",
      (entry) =>
        entry === "none" || entry === "thisServer" || entry === "allServers",
    ) &&
    isOptional(params, "temperature", isFiniteNumber) &&
    isOptional(params, "stopSequences", isStringArray) &&
    isOptional(params, "metadata", isObject) &&
    isOptional(
      params,
      "tools",
      (entry) => Array.isArray(entry) && entry.every(isSamplingTool),
    ) &&
    isOptional(
      params,
      "toolChoice",
      (entry) =>
        isObject(entry) &&
        isOptional(
          entry,
          "mode",
          (mode) => mode === "auto" || mode === "required" || mode === "none",
        ),
    )
  );
}

function isRootsRequest(value: Record<string, unknown>): boolean {
  return (
    value.params === undefined ||
    (isObject(value.params) && isOptional(value.params, "_meta", isObject))
  );
}

function hasOptionalSchemaText(value: Record<string, unknown>): boolean {
  return (
    isOptional(value, "title", (entry) => typeof entry === "string") &&
    isOptional(value, "description", (entry) => typeof entry === "string")
  );
}

function isPrimitiveSchema(value: unknown): boolean {
  if (!isObject(value) || !hasOptionalSchemaText(value)) return false;
  switch (value.type) {
    case "string":
      if (
        !isOptional(value, "default", (entry) => typeof entry === "string") ||
        !isOptional(value, "minLength", isFiniteNumber) ||
        !isOptional(value, "maxLength", isFiniteNumber) ||
        !isOptional(
          value,
          "format",
          (entry) =>
            entry === "email" ||
            entry === "uri" ||
            entry === "date" ||
            entry === "date-time",
        ) ||
        !isOptional(value, "enum", isStringArray) ||
        !isOptional(value, "enumNames", isStringArray)
      ) {
        return false;
      }
      if (value.enumNames !== undefined && value.enum === undefined) {
        return false;
      }
      return isOptional(
        value,
        "oneOf",
        (entry) =>
          Array.isArray(entry) &&
          entry.every(
            (option) =>
              isObject(option) &&
              typeof option.const === "string" &&
              typeof option.title === "string",
          ),
      );
    case "number":
    case "integer":
      return (
        isOptional(value, "minimum", isFiniteNumber) &&
        isOptional(value, "maximum", isFiniteNumber) &&
        isOptional(value, "default", isFiniteNumber)
      );
    case "boolean":
      return isOptional(
        value,
        "default",
        (entry) => typeof entry === "boolean",
      );
    case "array":
      if (
        !isOptional(value, "minItems", isFiniteNumber) ||
        !isOptional(value, "maxItems", isFiniteNumber) ||
        !isOptional(value, "default", isStringArray) ||
        !isObject(value.items)
      ) {
        return false;
      }
      if (value.items.type === "string") {
        return isStringArray(value.items.enum);
      }
      return (
        Array.isArray(value.items.anyOf) &&
        value.items.anyOf.every(
          (option) =>
            isObject(option) &&
            typeof option.const === "string" &&
            typeof option.title === "string",
        )
      );
    default:
      return false;
  }
}

function isElicitationRequest(value: Record<string, unknown>): boolean {
  if (!isObject(value.params) || typeof value.params.message !== "string") {
    return false;
  }
  const params = value.params;
  if (params.mode === "url") {
    return typeof params.elicitationId === "string" && isUrl(params.url);
  }
  if (params.mode !== undefined && params.mode !== "form") return false;
  if (!isObject(params.requestedSchema)) return false;
  const schema = params.requestedSchema;
  return (
    schema.type === "object" &&
    isObject(schema.properties) &&
    Object.values(schema.properties).every(isPrimitiveSchema) &&
    isOptional(schema, "required", isStringArray)
  );
}

/** Runtime counterpart of the official 2026-07-28 `InputRequest` union. */
export function isInputRequest(value: unknown): value is InputRequest {
  if (
    !isJsonValue(value) ||
    !isObject(value) ||
    !INPUT_REQUEST_METHODS.has(String(value.method))
  ) {
    return false;
  }
  switch (value.method) {
    case "sampling/createMessage":
      return isSamplingRequest(value);
    case "roots/list":
      return isRootsRequest(value);
    case "elicitation/create":
      return isElicitationRequest(value);
    default:
      return false;
  }
}

function isSamplingResponse(value: unknown): value is InputResponse {
  return (
    isObject(value) &&
    typeof value.model === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    isSamplingContent(value.content) &&
    isOptional(value, "stopReason", (entry) => typeof entry === "string") &&
    isOptional(value, "_meta", isObject)
  );
}

function isRootsResponse(value: unknown): value is InputResponse {
  return (
    isObject(value) &&
    Array.isArray(value.roots) &&
    value.roots.every(
      (root) =>
        isObject(root) &&
        typeof root.uri === "string" &&
        root.uri.startsWith("file://") &&
        isOptional(root, "name", (entry) => typeof entry === "string") &&
        isOptional(root, "_meta", isObject),
    )
  );
}

function isElicitationContentValue(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    isStringArray(value)
  );
}

function isElicitationResponse(value: unknown): value is InputResponse {
  return (
    isObject(value) &&
    (value.action === "accept" ||
      value.action === "decline" ||
      value.action === "cancel") &&
    (value.content === undefined ||
      (isObject(value.content) &&
        Object.values(value.content).every(isElicitationContentValue)))
  );
}

export function assertInputResponse(
  request: InputRequest,
  response: unknown,
  key: string,
): asserts response is InputResponse {
  if (!isJsonValue(response)) {
    throw new TypeError(
      `Input response ${JSON.stringify(key)} is not a pure JSON value`,
    );
  }
  const valid =
    request.method === "sampling/createMessage"
      ? isSamplingResponse(response)
      : request.method === "roots/list"
        ? isRootsResponse(response)
        : isElicitationResponse(response);

  if (!valid) {
    throw new TypeError(
      `Input response ${JSON.stringify(key)} does not match ${request.method}`,
    );
  }
}
