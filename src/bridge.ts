// The MoA provider bridge. It owns no model: every turn is handed to this
// plugin's server through the `moa_turn` tool, and the bridge forwards what
// the server reports — advisor rows, the aggregator's mirrored timeline, its
// approvals — as the MoA thread's own turn. See src/wire.ts for the channel.
import {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  createBridgeIo,
  decodeToolCallResponsePayload,
  experimental_defineProviderBridge,
  initializeParamsSchema,
  modelListParamsSchema,
  runBridgeRequest,
  threadDeltaSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  type ClientTurnRequestId,
  type ThreadDelta,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { z } from "zod";
import {
  MOA_TOOL_NAME,
  POLL_WAIT_MS,
  ackResultSchema,
  bridgeOptionsSchema,
  pollResultSchema,
  providerOptionsSchema,
  startResultSchema,
  type LogEntry,
  type ToolArgs,
  type TurnStatus,
} from "./wire.js";

type JsonRpcId = string | number;
type OutboundMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

const MAX_POLL_FAILURES = 5;

interface ActiveTurn {
  runId: string | null;
  cursor: number;
  stopped: boolean;
  /** Top-level items opened but not yet closed, by serialized key. */
  open: Map<string, Extract<ThreadDelta, { kind: "item.open" }>>;
}

interface Session {
  threadId: string;
  providerThreadId: string;
  turn: ActiveTurn | null;
}

const io = createBridgeIo<OutboundMessage>();
const sessions = new Map<string, Session>();
const pending = new Map<
  string,
  { resolve: (result: unknown) => void; reject: (error: Error) => void }
>();
let requestCounter = 0;
let callCounter = 0;

function notify(method: string, params: Record<string, unknown>): void {
  io.send({ jsonrpc: "2.0", method, params });
}

function emit(threadId: string, deltas: ThreadDelta[]): void {
  if (deltas.length > 0) {
    notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
  }
}

function log(message: string): void {
  process.stderr.write(`[moa-bridge] ${message}\n`);
}

/** A request to the runtime; settles when its response line arrives. */
function request(method: string, params: Record<string, unknown>): Promise<unknown> {
  requestCounter += 1;
  const id = `moa-req-${requestCounter}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    io.send({ jsonrpc: "2.0", id, method, params });
  });
}

async function callTool<T>(
  session: Session,
  args: ToolArgs,
  schema: z.ZodType<T>,
): Promise<T> {
  callCounter += 1;
  const result = await request(BRIDGE_INBOUND_REQUEST_METHODS.toolCall, {
    providerThreadId: session.providerThreadId,
    threadId: session.threadId,
    turnId: null,
    callId: `moa-call-${callCounter}`,
    tool: MOA_TOOL_NAME,
    arguments: args,
  });
  const decoded = decodeToolCallResponsePayload(result);
  if (decoded.isError) throw new Error(decoded.content || "moa_turn failed");
  return schema.parse(JSON.parse(decoded.content));
}

function keyOf(key: { providerItemId?: string; channel?: string; parentRef?: string }): string {
  return `${key.parentRef ?? ""}/${key.providerItemId ?? ""}/${key.channel ?? ""}`;
}

/** Validate each delta on its own so one bad row cannot void a batch. */
function forward(session: Session, turn: ActiveTurn, raw: readonly unknown[]): void {
  const deltas: ThreadDelta[] = [];
  for (const candidate of raw) {
    const parsed = threadDeltaSchema.safeParse(candidate);
    if (!parsed.success) {
      log(`dropped an invalid delta: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      continue;
    }
    const delta = parsed.data;
    if (delta.kind === "item.open" && delta.key.parentRef === undefined) {
      turn.open.set(keyOf(delta.key), delta);
    } else if (delta.kind === "item.close") {
      turn.open.delete(keyOf(delta.key));
    }
    deltas.push(delta);
  }
  emit(session.threadId, deltas);
}

/** Settle the turn: close whatever is still open, then the boundary. */
function finish(
  session: Session,
  turn: ActiveTurn,
  status: TurnStatus,
  error?: string,
): void {
  if (session.turn !== turn) return;
  session.turn = null;
  const deltas: ThreadDelta[] = [...turn.open.values()].map((open) => ({
    kind: "item.close",
    key: open.key,
    status,
    item: open.item,
    ...(open.presentation === undefined ? {} : { presentation: open.presentation }),
  }));
  turn.open.clear();
  deltas.push({
    kind: "turn.boundary",
    status,
    ...(error === undefined ? {} : { error: { message: error } }),
  });
  emit(session.threadId, deltas);
}

/** The resolution in an `interaction/request` answer (bare, or wrapped). */
export function resolutionOf(answer: unknown): Record<string, unknown> | null {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return null;
  const record = answer as Record<string, unknown>;
  const inner = record.resolution;
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return "decision" in record || "kind" in record ? record : null;
}

async function raiseInteraction(
  session: Session,
  turn: ActiveTurn,
  entry: Extract<LogEntry, { type: "interaction" }>,
): Promise<void> {
  try {
    // The runtime answers with the resolution itself, e.g. `{ decision }`.
    const answer = await request(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
      providerThreadId: session.providerThreadId,
      threadId: session.threadId,
      turnId: null,
      payload: entry.payload,
    });
    if (turn.stopped || turn.runId === null) return;
    const resolution = resolutionOf(answer);
    if (resolution === null) {
      log(`interaction ${entry.requestId}: unexpected answer ${JSON.stringify(answer)}`);
      return;
    }
    const ack = await callTool(
      session,
      { op: "resolve", runId: turn.runId, requestId: entry.requestId, resolution },
      ackResultSchema,
    );
    if (!ack.ok) log(`interaction ${entry.requestId}: the aggregator no longer waits for it`);
  } catch (error) {
    log(`interaction ${entry.requestId} failed: ${String(error)}`);
  }
}

async function runTurn(
  session: Session,
  input: readonly unknown[],
  providerOptions: unknown,
  clientRequestId?: ClientTurnRequestId,
): Promise<void> {
  const turn: ActiveTurn = { runId: null, cursor: 0, stopped: false, open: new Map() };
  session.turn = turn;
  emit(session.threadId, [
    ...(clientRequestId === undefined
      ? []
      : [{ kind: "input.accepted" as const, clientRequestId }]),
    { kind: "turn.open" },
  ]);

  const options = providerOptionsSchema.safeParse(providerOptions);
  if (!options.success) {
    finish(
      session,
      turn,
      "failed",
      "The Mixture of Agents plugin sent no preset for this turn. Reload the plugin and try again.",
    );
    return;
  }
  try {
    const started = await callTool(
      session,
      {
        op: "start",
        presetId: options.data.presetId,
        permissionMode: options.data.permissionMode,
        input: input as Record<string, unknown>[],
      },
      startResultSchema,
    );
    turn.runId = started.runId;
    let failures = 0;
    while (!turn.stopped) {
      let result;
      try {
        result = await callTool(
          session,
          { op: "poll", runId: started.runId, cursor: turn.cursor, waitMs: POLL_WAIT_MS },
          pollResultSchema,
        );
        failures = 0;
      } catch (error) {
        failures += 1;
        if (turn.stopped) return;
        if (failures >= MAX_POLL_FAILURES) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** failures));
        continue;
      }
      if (turn.stopped) return;
      turn.cursor = result.cursor;
      for (const entry of result.entries) {
        if (entry.type === "deltas") {
          forward(session, turn, entry.deltas);
        } else if (entry.type === "interaction") {
          void raiseInteraction(session, turn, entry);
        } else {
          finish(session, turn, entry.status, entry.error);
          return;
        }
      }
    }
  } catch (error) {
    if (!turn.stopped) {
      finish(session, turn, "failed", error instanceof Error ? error.message : String(error));
    }
  }
}

function openSession(threadId: string, providerThreadId: string): Session {
  const previous = sessions.get(threadId);
  if (previous?.turn) previous.turn.stopped = true;
  const session: Session = { threadId, providerThreadId, turn: null };
  sessions.set(threadId, session);
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId });
  emit(threadId, [{ kind: "session.reset" }]);
  return session;
}

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  io.send({
    jsonrpc: "2.0",
    id,
    error: {
      code: BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      message: `Invalid params for ${method}`,
      data: issues,
    },
  });
}

type Handler = (id: JsonRpcId, params: unknown) => void;

const handlers: Record<string, Handler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, "initialize", parsed.error.issues);
    io.sendResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
        // Session state lives on the plugin server, so any restart resumes.
        sessionRestore: true,
        threadArchive: false,
        threadRename: false,
        threadGoalClear: false,
        fork: "none",
        // The aggregator's own provider already applied the permission mode.
        approvalEnforcedBy: "provider",
        steerMode: "queue",
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, "model/list", parsed.error.issues);
    const options = bridgeOptionsSchema.safeParse(
      (params as { providerOptions?: unknown }).providerOptions,
    );
    io.sendResult(id, {
      models: options.success ? options.data.models : [],
      selectedOnlyModels: [],
    });
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, "thread/start", parsed.error.issues);
    // Derived from the bb thread id: unique per thread, stable across restarts.
    const providerThreadId = `moa-${parsed.data.threadId}`;
    const session = openSession(parsed.data.threadId, providerThreadId);
    io.sendResult(id, { providerThreadId, sessionRestorable: true });
    const input = parsed.data.input ?? [];
    if (input.length > 0) {
      void runTurn(session, input, parsed.data.options.providerOptions);
    }
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, "thread/resume", parsed.error.issues);
    openSession(parsed.data.threadId, parsed.data.providerThreadId);
    io.sendResult(id, {
      providerThreadId: parsed.data.providerThreadId,
      sessionRestorable: true,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, "turn/start", parsed.error.issues);
    const session = sessions.get(parsed.data.threadId);
    if (session === undefined) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        `No session for thread ${parsed.data.threadId}; send thread/start or thread/resume first`,
      );
      return;
    }
    if (session.turn !== null) {
      io.sendError(
        id,
        BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
        "A Mixture of Agents turn is already running on this thread",
      );
      return;
    }
    io.sendResult(id, {});
    void runTurn(
      session,
      parsed.data.input,
      parsed.data.options.providerOptions,
      parsed.data.clientRequestId,
    );
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, "turn/steer", parsed.error.issues);
    io.sendError(
      id,
      BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
      "Mixture of Agents turns cannot be steered; the message runs as the next turn",
    );
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) return invalidParams(id, "thread/stop", parsed.error.issues);
    const session = sessions.get(parsed.data.threadId);
    const turn = session?.turn ?? null;
    if (session !== undefined && turn !== null && parsed.data.intent === "interrupt") {
      if (turn.runId !== null) {
        // Best effort: the server also stops the workers once the MoA thread
        // settles, so a lost call still ends the run.
        void callTool(session, { op: "interrupt", runId: turn.runId }, ackResultSchema).catch(
          () => undefined,
        );
      }
      turn.stopped = true;
      finish(session, turn, "interrupted");
    } else if (turn !== null) {
      turn.stopped = true;
    }
    sessions.delete(parsed.data.threadId);
    io.sendResult(id, {});
  },
};

function handleResponse(message: Record<string, unknown>): void {
  const id = message.id;
  if (typeof id !== "string") return;
  const waiter = pending.get(id);
  if (waiter === undefined) return;
  pending.delete(id);
  if (message.error !== undefined) {
    const error = message.error as { message?: unknown };
    waiter.reject(
      new Error(typeof error.message === "string" ? error.message : "request failed"),
    );
    return;
  }
  waiter.resolve(message.result);
}

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) return;
  const record = message as Record<string, unknown>;
  const { id, method, params } = record;
  if (typeof method !== "string") {
    handleResponse(record);
    return;
  }
  if (typeof id !== "string" && typeof id !== "number") return;
  const handler = handlers[method];
  if (handler === undefined) {
    io.sendError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  runBridgeRequest({
    request: { id, method, params },
    sendError: io.sendError,
    handleRequest: async (req) => handler(req.id, req.params),
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  onClose() {
    for (const session of sessions.values()) {
      if (session.turn) session.turn.stopped = true;
    }
    for (const waiter of pending.values()) waiter.reject(new Error("bridge closed"));
    pending.clear();
  },
});
