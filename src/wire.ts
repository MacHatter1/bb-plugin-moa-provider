// The bridge ↔ server channel. The MoA bridge runs on whichever machine hosts
// the thread; it reaches this plugin's server by calling the `moa_turn` agent
// tool through the runtime (`item/tool/call`), which is authenticated and
// routed for every enrolled machine. A turn is one `start`, then `poll`s until
// a `done` entry arrives. Polls are short: the runtime's HTTP hop gives up on
// a silent response after a few minutes, so no call may block for long.
import { z } from "zod";

export { MOA_PROVIDER_ID as PROVIDER_ID } from "./constants.js";
export const MOA_TOOL_NAME = "moa_turn";

/** Longest a poll holds the connection open waiting for news. */
export const POLL_WAIT_MS = 20_000;

export const permissionModeSchema = z.enum(["accept-edits", "auto", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const startArgsSchema = z.object({
  op: z.literal("start"),
  presetId: z.string().min(1),
  permissionMode: permissionModeSchema,
  /** The turn's PromptInput[], forwarded to the aggregator unchanged. */
  input: z.array(z.record(z.string(), z.unknown())).min(1),
});

export const pollArgsSchema = z.object({
  op: z.literal("poll"),
  runId: z.string().min(1),
  /** Index of the first log entry the bridge has not seen yet. */
  cursor: z.number().int().nonnegative(),
  waitMs: z.number().int().min(0).max(POLL_WAIT_MS),
});

export const resolveArgsSchema = z.object({
  op: z.literal("resolve"),
  runId: z.string().min(1),
  requestId: z.string().min(1),
  resolution: z.record(z.string(), z.unknown()),
});

export const interruptArgsSchema = z.object({
  op: z.literal("interrupt"),
  runId: z.string().min(1),
});

export const toolArgsSchema = z.discriminatedUnion("op", [
  startArgsSchema,
  pollArgsSchema,
  resolveArgsSchema,
  interruptArgsSchema,
]);
export type ToolArgs = z.infer<typeof toolArgsSchema>;
export type StartArgs = z.infer<typeof startArgsSchema>;

export const turnStatusSchema = z.enum(["completed", "failed", "interrupted"]);
export type TurnStatus = z.infer<typeof turnStatusSchema>;

/**
 * One entry of a run's ordered log. Deltas are pre-built `thread/delta`
 * grammar the bridge validates and forwards; an interaction asks the bridge to
 * raise the aggregator's approval or question in the MoA thread.
 */
export const logEntrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("deltas"), deltas: z.array(z.unknown()) }),
  z.object({
    type: z.literal("interaction"),
    requestId: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("done"),
    status: turnStatusSchema,
    error: z.string().optional(),
  }),
]);
export type LogEntry = z.infer<typeof logEntrySchema>;

export const startResultSchema = z.object({ runId: z.string().min(1) });
export const pollResultSchema = z.object({
  cursor: z.number().int().nonnegative(),
  entries: z.array(logEntrySchema),
});
export type PollResult = z.infer<typeof pollResultSchema>;
export const ackResultSchema = z.object({ ok: z.boolean() });

/** What `deriveProviderOptions` hands the bridge on every turn. */
export const providerOptionsSchema = z.object({
  presetId: z.string().min(1),
  permissionMode: permissionModeSchema,
});
export type MoaProviderOptions = z.infer<typeof providerOptionsSchema>;

/** Static bridge options: the picker catalog, re-registered when presets change. */
export const bridgeModelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  description: z.string(),
  supportedReasoningEfforts: z.array(
    z.object({ reasoningEffort: z.string(), description: z.string() }),
  ),
  defaultReasoningEffort: z.string(),
  isDefault: z.boolean(),
});
export const bridgeOptionsSchema = z.object({
  models: z.array(bridgeModelSchema),
});
