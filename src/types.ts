/**
 * The public contract, and nothing else. Every type here is re-exported by
 * `index.ts`, and every type `index.ts` exports lives here. Types describing
 * how two internal modules talk to each other belong with the module that owns
 * them, so this file keeps answering "what does a consumer get?" on its own.
 *
 * Field-level shapes follow `test/fixtures/ext-tasks/schema.ts`, which is
 * upstream's declared source of truth. Where this file is narrower than the
 * generated `schema.json`, that is deliberate — see `docs/contract.md#input-rounds`.
 */

/** @see docs/contract.md#state-model */
export type TaskStatus =
  "working" | "input_required" | "completed" | "failed" | "cancelled";

/** The three statuses a task can never leave (I2). */
export type TerminalTaskStatus = "completed" | "failed" | "cancelled";

/**
 * A server-to-client request parked on a task waiting for input.
 *
 * The extension does not define a free-form input channel: an input request is
 * one of the three server-to-client requests MCP already has. Structural rather
 * than imported because the main entry point has no dependencies; the nested
 * MCP shapes are mirrored here and checked recursively at runtime.
 */
interface ContentAnnotations {
  audience?: readonly ("user" | "assistant")[];
  priority?: number;
  lastModified?: string;
}

interface ContentIcon {
  src: string;
  mimeType?: string;
  sizes?: readonly string[];
  theme?: "light" | "dark";
}

interface TextContent {
  type: "text";
  text: string;
  annotations?: ContentAnnotations;
  _meta?: JsonObject;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
  _meta?: JsonObject;
}

interface AudioContent {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
  _meta?: JsonObject;
}

interface ResourceLinkContent {
  type: "resource_link";
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  icons?: readonly ContentIcon[];
  annotations?: ContentAnnotations;
  _meta?: JsonObject;
}

interface EmbeddedResourceContent {
  type: "resource";
  resource:
    | { uri: string; mimeType?: string; text: string; _meta?: JsonObject }
    | { uri: string; mimeType?: string; blob: string; _meta?: JsonObject };
  annotations?: ContentAnnotations;
  _meta?: JsonObject;
}

type ToolResultContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLinkContent
  | EmbeddedResourceContent;

interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonObject;
  _meta?: JsonObject;
}

interface ToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: readonly ToolResultContentBlock[];
  structuredContent?: JsonObject;
  isError?: boolean;
  _meta?: JsonObject;
}

type SamplingContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ToolUseContent
  | ToolResultContent;

interface SamplingMessage {
  role: "user" | "assistant";
  content: SamplingContentBlock | readonly SamplingContentBlock[];
  _meta?: JsonObject;
}

interface SamplingTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject & { type: "object" };
  outputSchema?: JsonObject & { type: "object" };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  icons?: readonly ContentIcon[];
  execution?: {
    taskSupport?: "required" | "optional" | "forbidden";
  };
  _meta?: JsonObject;
}

interface ModelPreferences {
  hints?: readonly { name?: string }[];
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

interface SamplingInputRequest {
  method: "sampling/createMessage";
  params: {
    messages: readonly SamplingMessage[];
    maxTokens: number;
    modelPreferences?: ModelPreferences;
    systemPrompt?: string;
    includeContext?: "none" | "thisServer" | "allServers";
    temperature?: number;
    stopSequences?: readonly string[];
    metadata?: JsonObject;
    tools?: readonly SamplingTool[];
    toolChoice?: { mode?: "auto" | "required" | "none" };
  };
}

interface RootsInputRequest {
  method: "roots/list";
  params?: { _meta?: JsonObject };
}

type PrimitiveSchemaDefinition =
  | {
      type: "string";
      title?: string;
      description?: string;
      minLength?: number;
      maxLength?: number;
      format?: "email" | "uri" | "date" | "date-time";
      default?: string;
      enum?: readonly string[];
      enumNames?: readonly string[];
      oneOf?: readonly { const: string; title: string }[];
    }
  | {
      type: "number" | "integer";
      title?: string;
      description?: string;
      minimum?: number;
      maximum?: number;
      default?: number;
    }
  | {
      type: "boolean";
      title?: string;
      description?: string;
      default?: boolean;
    }
  | {
      type: "array";
      title?: string;
      description?: string;
      minItems?: number;
      maxItems?: number;
      items:
        | { type: "string"; enum: readonly string[] }
        | { anyOf: readonly { const: string; title: string }[] };
      default?: readonly string[];
    };

interface ElicitationInputRequest {
  method: "elicitation/create";
  params:
    | {
        mode?: "form";
        message: string;
        requestedSchema: {
          type: "object";
          properties: Record<string, PrimitiveSchemaDefinition>;
          required?: readonly string[];
        };
      }
    | {
        mode: "url";
        message: string;
        elicitationId: string;
        url: string;
      };
}

export type InputRequest =
  SamplingInputRequest | RootsInputRequest | ElicitationInputRequest;

interface SamplingInputResponse {
  model: string;
  role: "user" | "assistant";
  content: SamplingContentBlock | readonly SamplingContentBlock[];
  stopReason?: string;
  _meta?: JsonObject;
}

interface RootsInputResponse {
  roots: readonly {
    uri: string;
    name?: string;
    _meta?: JsonObject;
  }[];
}

interface ElicitationInputResponse {
  action: "accept" | "decline" | "cancel";
  content?: { [key: string]: string | number | boolean | readonly string[] };
}

/** A client's answer to one {@linkcode InputRequest}. */
export type InputResponse =
  SamplingInputResponse | RootsInputResponse | ElicitationInputResponse;

/**
 * Outstanding server-to-client requests, keyed by an identifier that matches
 * requests to responses. Each key is unique for the whole lifetime of a task
 * and is never reused, not even after the task is terminal (I5).
 */
export type InputRequests = Readonly<Record<string, InputRequest>>;

/** Client responses to outstanding input requests, keyed the same way. */
export type InputResponses = Readonly<Record<string, InputResponse>>;

/** A value that survives JSON encoding and decoding without changing shape. */
export type JsonValue =
  string | number | boolean | null | JsonObject | readonly JsonValue[];

/** A recursive JSON object, which the schema requires for `result` and `error`. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * What a {@linkcode TaskStore} persists.
 *
 * **This is not the wire shape.** Every task variant in the extension's schema
 * sets `additionalProperties: false`, so `version`, `inputResponses` and
 * `usedInputKeys` — all of which a correct store must keep — would make a
 * `tasks/get` response non-conforming. The projection to the wire is one
 * function (`toDetailedTask`) and it is allow-list based for that reason.
 */
export interface TaskRecord {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly statusMessage?: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601. Never decreases (I4). */
  readonly lastUpdatedAt: string;
  /** Milliseconds from `createdAt`; `null` means unlimited. */
  readonly ttlMs: number | null;
  /** Optional on the wire, so optional here. */
  readonly pollIntervalMs?: number;
  /** Present while, and only while, `status === 'input_required'`. */
  readonly inputRequests?: InputRequests;
  /** Responses gathered so far for the outstanding round. Internal. */
  readonly inputResponses?: InputResponses;
  /**
   * Every input key this task has ever issued. Internal, and it must survive
   * both the terminal transition and a store replay: the spec forbids reusing
   * a key for the lifetime of the task, which does not end at `completed`.
   */
  readonly usedInputKeys?: readonly string[];
  /** Present when `status === 'completed'`. */
  readonly result?: JsonObject;
  /** Present when `status === 'failed'`. */
  readonly error?: JsonObject;
  /** Optimistic-concurrency counter. Owned by the store, never serialised. */
  readonly version: number;
}

/**
 * The fields a store may be asked to change.
 *
 * Patch semantics apply enumerable own string-keyed properties. For each such
 * property, a value of `undefined` MUST delete that field from the stored
 * record. Inherited, symbol-keyed and non-enumerable properties are outside
 * the patch; `undefined` never means "leave unchanged" here.
 */
export type TaskPatch = Partial<
  Omit<TaskRecord, "taskId" | "createdAt" | "version">
>;

/**
 * Five methods. This is the contract a Redis, Postgres, SQLite or D1 store
 * implements — and `mcp-durable-tasks/testing` is the suite that proves one
 * correct before it ships.
 */
export interface TaskStore {
  /**
   * I1: MUST NOT resolve until the record is durable and a subsequent `get()`
   * would return it. The extension states this normatively about
   * `CreateTaskResult`, and it is the invariant the whole package exists for.
   */
  create(record: TaskRecord): Promise<void>;

  /** `undefined` if the task does not exist or its TTL has elapsed. */
  get(taskId: string): Promise<TaskRecord | undefined>;

  /**
   * Compare-and-swap. Rejects with `ConcurrentUpdateError` when the stored
   * version is not `expectedVersion`, and returns the written record. Applies
   * every enumerable own string-keyed patch property; an `undefined` value
   * deletes that field.
   */
  update(
    taskId: string,
    patch: TaskPatch,
    expectedVersion: number,
  ): Promise<TaskRecord>;

  /** Drops expired tasks and returns how many. Never returns payloads (I7). */
  sweep(now?: number): Promise<number>;

  close(): Promise<void>;
}

/* ---------------------------------------------------------------------------
 * Wire shapes — what `tasks/*` actually returns.
 * ------------------------------------------------------------------------ */

interface BaseTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}

interface CompleteResult {
  resultType: "complete";
}

export interface WorkingTask extends BaseTask, CompleteResult {
  status: "working";
}
export interface InputRequiredTask extends BaseTask, CompleteResult {
  status: "input_required";
  inputRequests: InputRequests;
}
export interface CompletedTask extends BaseTask, CompleteResult {
  status: "completed";
  result: JsonObject;
}
export interface FailedTask extends BaseTask, CompleteResult {
  status: "failed";
  error: JsonObject;
}
export interface CancelledTask extends BaseTask, CompleteResult {
  status: "cancelled";
}

/** Discriminated by `status`, exactly as the schema declares it. */
export type DetailedTask =
  WorkingTask | InputRequiredTask | CompletedTask | FailedTask | CancelledTask;

/**
 * What a server returns in lieu of a normal result when it defers the work.
 * `Result & Task` in the schema: the base task, flat, without the
 * status-specific fields.
 */
export type CreateTaskResult = BaseTask & { resultType: "task" };

/** What `tasks/get` returns. */
export type GetTaskResult = DetailedTask;

/** Empty `tasks/update` acknowledgement, with the required discriminator. */
export type UpdateTaskResult = CompleteResult;

/** Empty `tasks/cancel` acknowledgement, with the required discriminator. */
export type CancelTaskResult = CompleteResult;

/* ------------------------------------------------------------------------ */

export interface TaskLifecycleOptions {
  store: TaskStore;
  /** Default `ttlMs` for new tasks. `null` means unlimited. Default 1 hour. */
  defaultTtlMs?: number | null;
  /** Default `pollIntervalMs` hint. `null` sends none. Default 1000. */
  defaultPollIntervalMs?: number | null;
  /** How often to sweep expired tasks. `null` disables the timer. */
  sweepIntervalMs?: number | null;
  /** Injectable clock, in epoch milliseconds. Tests use it; nothing else. */
  now?: () => number;
  /** Injectable ID generator. Must stay unguessable (I6). */
  generateTaskId?: () => string;
}

/** What a worker is given. The task's write side. */
export interface TaskHandle {
  readonly taskId: string;
  /** Fires when `tasks/cancel` arrives. Cooperative: nothing is killed. */
  readonly signal: AbortSignal;

  /** Reports progress, and optionally revises the polling or TTL hints. */
  progress(
    statusMessage: string,
    patch?: { pollIntervalMs?: number; ttlMs?: number | null },
  ): Promise<void>;

  /**
   * Parks the task in `input_required` and resolves once every key has been
   * answered through `tasks/update`. Partial answers are accepted and keep the
   * task parked.
   */
  requestInput(requests: Record<string, InputRequest>): Promise<InputResponses>;

  /** Terminal. The result must be a JSON object, per the schema. */
  complete(result: JsonObject): Promise<void>;

  /** Terminal. Carries the JSON-RPC error that ended the task. */
  fail(error: JsonObject): Promise<void>;

  /**
   * Terminal. Acknowledges a cancellation the worker chose to honour.
   *
   * Not in the original API sketch, and added because without it `cancelled`
   * is unreachable: `tasks/cancel` only raises the worker's signal, since
   * cancellation is cooperative and the task MAY still finish some other way.
   * Something has to write the terminal state once the worker has actually
   * stopped, and only the worker knows when that is.
   */
  cancelled(statusMessage?: string): Promise<void>;
}
