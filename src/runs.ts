// Server-side orchestration of one MoA turn.
//
// Every slot of a preset runs as a hidden BB worker thread on its own
// provider, in the MoA thread's environment, owned by the MoA thread so it
// archives and deletes with it. Advisors answer first, in parallel; the
// aggregator then gets the user's input plus their notes and does the work.
// Its timeline is mirrored into the MoA thread while it runs, and its
// approvals and questions are raised there. Workers persist across turns, so
// each keeps its own conversation (and prompt cache) for the whole thread.
//
// With a mid-turn fanout the aggregator also gets `moa_consult`, which asks
// the advisors again while it works; with "every-n" the server nudges it to
// call that tool every N tool calls, through BB's ordinary steer.
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { CONSULT_TOOL_NAME, MOA_PLUGIN_ID } from "./constants.js";
import { AdvisorStream } from "./advisor-stream.js";
import { AggregatorMirror, isToolCompletion } from "./mirror.js";
import {
  activeAdvisors,
  consultsMidTurn,
  defaultPresetId,
  findPreset,
  slotSignature,
  type Preset,
  type PresetStore,
  type Slot,
} from "./presets.js";
import {
  roundDirective,
  roundId,
  type AdvisorEntry,
  type AdvisorRound,
  type AdvisorStatus,
  type RoundStore,
} from "./rounds.js";
import {
  HISTORY_TURNS,
  advisorConsultPrompt,
  advisorFirstPrompt,
  advisorFollowUpPrompt,
  advisorAskPrompt,
  advisorNotesBlock,
  aggregatorPreamble,
  askAnswersText,
  askProgressText,
  askStartedText,
  consultNudge,
  consultResultText,
  promptText,
  roundHandoffText,
  type AdvisorNote,
  type HistoryTurn,
} from "./prompts.js";
import type {
  LogEntry,
  PermissionMode,
  PollResult,
  StartArgs,
  TurnStatus,
} from "./wire.js";

type Sdk = BbPluginApi["sdk"];
type Input = Record<string, unknown>[];

/** Per-MoA-thread memory, in kv under `thread:<id>`. */
interface ThreadState {
  aggregator: { signature: string; threadId: string; consult?: boolean } | null;
  advisors: Record<string, string>;
  history: HistoryTurn[];
}

const EMPTY_THREAD_STATE: ThreadState = {
  aggregator: null,
  advisors: {},
  history: [],
};

/** Polling cadence; tests shorten it. */
export interface Timing {
  advisorPollMs: number;
  aggregatorPollMs: number;
  interactionPollMs: number;
  statusPollMs: number;
  /** A worker with no turn this long after the send failed to start. */
  startGraceMs: number;
  /**
   * Longest a `moa_consult` call may block. The tool's reply crosses an HTTP
   * hop that gives up on a silent response after about five minutes.
   */
  consultMaxMs: number;
  /**
   * Longest one `moa_answers` call waits before reporting progress. Kept
   * under the 60 seconds after which Cursor's and Codex's MCP clients cancel
   * a tool call.
   */
  answersWaitMs: number;
  /** Ceiling for a round that keeps making progress (idle limits aside). */
  roundMaxMs: number;
  /** How often a working advisor's progress is saved for its panel. */
  progressCommitMs: number;
}

const DEFAULT_TIMING: Timing = {
  advisorPollMs: 1_000,
  aggregatorPollMs: 300,
  interactionPollMs: 1_500,
  statusPollMs: 3_000,
  startGraceMs: 10_000,
  consultMaxMs: 240_000,
  answersWaitMs: 45_000,
  roundMaxMs: 30 * 60_000,
  progressCommitMs: 800,
};
/** `threads.events.list` refuses a larger page. */
const EVENT_PAGE = 100;
const STOP_WAIT_MS = 30_000;
/** A run nobody has polled for this long lost its bridge. */
const ORPHAN_MS = 90_000;
/** Longest a check-in panel waits for the mirror to catch up. */
const MIRROR_CATCH_UP_MS = 3_000;
/** Finished runs linger this long so a retried poll still finds `done`. */
const FINISHED_TTL_MS = 5 * 60_000;
const POLL_RESPONSE_BUDGET = 2 * 1024 * 1024;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * An approval the aggregator's provider asks for before calling
 * `moa_consult` (ACP agents gate every MCP tool). The tool only reads, so the
 * plugin grants it itself instead of interrupting the user.
 */
export function consultApprovalDecision(
  payload: Record<string, unknown>,
): "allow_for_session" | "allow_once" | null {
  if (payload.kind !== "approval") return null;
  const subject = payload.subject as Record<string, unknown> | undefined;
  if (subject?.kind !== "tool_use") return null;
  const presentation = subject.presentation as { title?: unknown } | undefined;
  const names = [subject.tool, presentation?.title].filter(
    (value): value is string => typeof value === "string",
  );
  // Whole identifiers only, after any `mcp__server__` or `server-` prefix.
  const named = names.some((name) =>
    name.split(/[^A-Za-z0-9_]+|__/u).includes(CONSULT_TOOL_NAME),
  );
  if (!named) return null;
  const decisions = Array.isArray(payload.availableDecisions) ? payload.availableDecisions : [];
  if (decisions.includes("allow_for_session")) return "allow_for_session";
  return decisions.includes("allow_once") ? "allow_once" : null;
}

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)} minutes`;
}

/** A preset's advisors, each with a worker key; repeats get `sig#2`, … */
function advisorSlots(preset: Preset): AdvisorSlot[] {
  const seen = new Map<string, number>();
  return activeAdvisors(preset).map((slot) => {
    const signature = slotSignature(slot);
    const count = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, count);
    return { slot, workerKey: count === 1 ? signature : `${signature}#${count}` };
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Run {
  readonly id = randomUUID();
  readonly controller = new AbortController();
  readonly interactions = new Map<
    string,
    { threadId: string; interactionId: string }
  >();
  /** Worker threads this run started a turn on, for interruption. */
  readonly busyWorkers = new Set<string>();
  /** Set while the aggregator works: what `moa_consult` needs. */
  consultation: Consultation | null = null;
  lastPollAt = Date.now();
  finishedAt: number | null = null;
  private readonly log: LogEntry[] = [];
  private readonly waiters = new Set<() => void>();

  constructor(readonly moaThreadId: string) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }
  get done(): boolean {
    return this.finishedAt !== null;
  }

  push(entry: LogEntry): void {
    if (this.done) return;
    this.log.push(entry);
    if (entry.type === "done") this.finishedAt = Date.now();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  deltas(deltas: readonly ThreadDelta[]): void {
    if (deltas.length > 0) this.push({ type: "deltas", deltas: [...deltas] });
  }

  async read(
    cursor: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<PollResult> {
    this.lastPollAt = Date.now();
    if (cursor >= this.log.length && !this.done && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, waitMs);
        const wake = () => finish();
        function finish() {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        }
        this.waiters.add(wake);
        signal.addEventListener("abort", finish, { once: true });
      });
    }
    this.lastPollAt = Date.now();
    const entries: LogEntry[] = [];
    let size = 0;
    let next = Math.min(cursor, this.log.length);
    while (next < this.log.length) {
      const entry = this.log[next]!;
      size += JSON.stringify(entry).length;
      if (entries.length > 0 && size > POLL_RESPONSE_BUDGET) break;
      entries.push(entry);
      next += 1;
    }
    return { cursor: next, entries };
  }
}

interface TurnContext {
  run: Run;
  projectId: string;
  environmentId: string;
  permissionMode: PermissionMode;
  state: ThreadState;
  userText: string;
  preset: Preset;
  advisors: AdvisorSlot[];
  /** MoA turns embed each round as a panel; `/moa` asks leave that to the agent. */
  embedPanels: boolean;
}

/** An advisor slot and the key of the worker thread that serves it. */
interface AdvisorSlot {
  slot: Slot;
  workerKey: string;
}

/** Mid-turn consultation state for the aggregator of one run. */
interface Consultation {
  ctx: TurnContext;
  aggregatorThreadId: string;
  mirror: AggregatorMirror;
  /** Top-level tool calls since the advisors were last asked. */
  toolsSinceConsult: number;
  /** `toolsSinceConsult` when the last check-in was sent, while unanswered. */
  nudgedAt: number | null;
  inFlight: Promise<string> | null;
  rounds: number;
  /** The aggregator event sequence the mirror has copied so far. */
  mirroredSeq: number;
}

interface FollowResult {
  status: TurnStatus | "timeout";
  /** For a timeout: no progress for the idle limit, or past the ceiling. */
  timeoutReason?: "idle" | "limit";
  error?: string;
  lastAgentMessage: string | null;
}

interface ProviderFacts {
  displayName: string;
  permissionModes: PermissionMode[];
  models: Map<string, string>;
}

export interface MoaRunsDeps {
  sdk(): Sdk;
  loadStore(): Promise<PresetStore>;
  /** Stop an advisor that shows no progress for this long. */
  advisorIdleMs(): Promise<number>;
  kv: BbPluginApi["storage"]["kv"];
  log: BbPluginApi["log"];
  /** Where advisor rounds are kept for their panels. */
  rounds: RoundStore;
  /** Tell open panels that a round changed. */
  publishRound(id: string): void;
  timing?: Partial<Timing>;
}

export class MoaRuns {
  private readonly runs = new Map<string, Run>();
  private readonly activeByThread = new Map<string, Run>();
  /** Runs by the aggregator worker currently working for them. */
  private readonly byAggregator = new Map<string, Run>();
  /** The `/moa` ask in flight per asking thread, for one-at-a-time. */
  private readonly asksByThread = new Map<string, Promise<AdvisorNote[]>>();
  /** Unsettled `/moa` asks per asking thread, stopped when its turn ends. */
  private readonly askRuns = new Map<string, Set<Run>>();
  /** `/moa` rounds by id, for `moa_answers`. */
  private readonly asks = new Map<
    string,
    { threadId: string; run: Run; result: Promise<AdvisorNote[]> }
  >();
  private readonly providerCache = new Map<
    string,
    { at: number; facts: ProviderFacts }
  >();
  /** Workspace paths by environment, for shortening advisor activity. */
  private readonly workspacePaths = new Map<string, string>();

  private readonly timing: Timing;

  constructor(private readonly deps: MoaRunsDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  start(moaThreadId: string, args: StartArgs): string {
    this.activeByThread.get(moaThreadId)?.controller.abort();
    const run = new Run(moaThreadId);
    this.runs.set(run.id, run);
    this.activeByThread.set(moaThreadId, run);
    void this.execute(run, args);
    return run.id;
  }

  /** A run, only for the MoA thread that started it. */
  private owned(threadId: string, runId: string): Run | undefined {
    const run = this.runs.get(runId);
    return run?.moaThreadId === threadId ? run : undefined;
  }

  async poll(
    threadId: string,
    runId: string,
    cursor: number,
    waitMs: number,
    signal: AbortSignal,
  ): Promise<PollResult> {
    const run = this.owned(threadId, runId);
    if (run === undefined) {
      return {
        cursor,
        entries: [
          {
            type: "done",
            status: "failed",
            error:
              "This Mixture of Agents turn is no longer running (the plugin reloaded). Send the message again.",
          },
        ],
      };
    }
    return run.read(cursor, waitMs, signal);
  }

  async resolve(
    threadId: string,
    runId: string,
    requestId: string,
    resolution: Record<string, unknown>,
  ): Promise<boolean> {
    const target = this.owned(threadId, runId)?.interactions.get(requestId);
    if (target === undefined) return false;
    try {
      await this.deps.sdk().threads.interactions.resolve({
        threadId: target.threadId,
        interactionId: target.interactionId,
        resolution: resolution as never,
      });
      return true;
    } catch (error) {
      this.deps.log.warn(`resolve ${requestId} failed: ${errorMessage(error)}`);
      return false;
    }
  }

  interrupt(threadId: string, runId: string): void {
    this.owned(threadId, runId)?.controller.abort();
  }

  /**
   * `moa_consult`, called by an aggregator mid-turn: ask the advisors again
   * and return their notes. Concurrent calls share one round.
   */
  async consultAdvisors(
    aggregatorThreadId: string,
    question: string,
    signal: AbortSignal,
  ): Promise<string> {
    const run = this.byAggregator.get(aggregatorThreadId);
    const consultation = run?.consultation ?? null;
    if (run === undefined || run.done || consultation === null) {
      return "No Mixture of Agents turn is running for this thread, so there are no advisors to ask. Carry on.";
    }
    if (consultation.inFlight === null) {
      consultation.inFlight = this.consultRound(run, consultation, question, signal).finally(
        () => {
          consultation.inFlight = null;
          consultation.toolsSinceConsult = 0;
          consultation.nudgedAt = null;
        },
      );
    }
    return consultation.inFlight;
  }

  /**
   * The MoA thread settled (idle/failed) while a run was live: the user
   * stopped it. Lifecycle events are delivered late, so confirm the thread
   * is still settled before aborting a run that may belong to a newer turn.
   */
  async onThreadSettled(threadId: string): Promise<void> {
    const active = this.activeByThread.get(threadId);
    const run = active !== undefined && !active.done ? active : null;
    const asks = [...(this.askRuns.get(threadId) ?? [])];
    if (run === null && asks.length === 0) return;
    const thread = await this.deps.sdk().threads.get({ threadId }).catch(() => null);
    if (thread !== null && thread.status !== "idle" && thread.status !== "error") return;
    if (run !== null && this.activeByThread.get(threadId) === run) run.controller.abort();
    // The turn that asked has ended, so nobody is waiting for these advisors.
    for (const ask of asks) ask.controller.abort();
  }

  /**
   * `moa_ask`, for `/moa <question>` in any other thread: start a preset's
   * advisors as workers owned by that thread and return as soon as their
   * round exists, so the asking agent can show the live panel while they
   * work; `moa_answers` then waits for them. Asks in one thread run one at a
   * time, since they share that thread's advisor workers.
   */
  async startAsk(args: {
    threadId: string;
    question: string;
    context: string | null;
    presetId: string | null;
  }): Promise<string> {
    const store = await this.deps.loadStore();
    const presetId = args.presetId ?? defaultPresetId(store);
    const preset = presetId === null ? null : findPreset(store, presetId);
    if (preset === null) {
      const known = store.presets.map((entry) => entry.id).join(", ");
      throw new Error(
        presetId === null
          ? "There are no Mixture of Agents presets yet. Create one under Settings → Plugins → MoA Provider."
          : `There is no Mixture of Agents preset "${presetId}". Presets: ${known || "none"}.`,
      );
    }
    const advisors = advisorSlots(preset);
    if (advisors.length === 0) {
      throw new Error(
        `The "${preset.name}" preset has no advisors switched on. Add some under Settings → Plugins → MoA Provider.`,
      );
    }
    const thread = await this.deps.sdk().threads.get({ threadId: args.threadId });
    if (!("environmentId" in thread) || thread.environmentId === null) {
      throw new Error("This thread has no environment for the advisors to work in.");
    }

    const run = new Run(args.threadId);
    run.signal.addEventListener("abort", () => void this.stopWorkers(run), { once: true });
    const pending = this.askRuns.get(args.threadId) ?? new Set<Run>();
    pending.add(run);
    this.askRuns.set(args.threadId, pending);
    let started!: (id: string) => void;
    let failed!: (error: unknown) => void;
    const roundStarted = new Promise<string>((resolve, reject) => {
      started = resolve;
      failed = reject;
    });
    const previous = this.asksByThread.get(args.threadId) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        const ctx: TurnContext = {
          run,
          projectId: thread.projectId,
          environmentId: thread.environmentId!,
          // Advisors only read; this is the most restrained shared mode.
          permissionMode: "accept-edits",
          state: await this.loadThreadState(args.threadId),
          userText: args.question,
          preset,
          advisors,
          embedPanels: false,
        };
        const { notes } = await this.runRound(ctx, {
          round: 0,
          question: args.question,
          idleMs: await this.deps.advisorIdleMs(),
          maxMs: this.timing.roundMaxMs,
          signal: run.signal,
          prompt: (fresh) => advisorAskPrompt(fresh, args.question, args.context),
          onStarted: started,
        });
        await this.saveThreadState(args.threadId, ctx.state);
        return notes;
      })
      .finally(async () => {
        if (run.busyWorkers.size > 0) await this.stopWorkers(run);
      });
    result.catch(failed);
    // Settling without a round (it never began) must not leave the ask hanging.
    void result.then(() => failed(new Error("The advisors did not start.")), () => undefined);
    this.asksByThread.set(args.threadId, result);
    void result
      .catch(() => undefined)
      .then(() => {
        if (this.asksByThread.get(args.threadId) === result) this.asksByThread.delete(args.threadId);
        pending.delete(run);
        if (pending.size === 0 && this.askRuns.get(args.threadId) === pending) {
          this.askRuns.delete(args.threadId);
        }
      });

    const id = await roundStarted;
    this.asks.set(id, { threadId: args.threadId, run, result });
    // Answers stay collectable for a while after the round ends.
    void result
      .catch(() => undefined)
      .then(() => {
        setTimeout(() => this.asks.delete(id), FINISHED_TTL_MS).unref?.();
      });
    return askStartedText(roundDirective(id), id);
  }

  /**
   * `moa_answers`: wait for a round `moa_ask` started in this thread and
   * return the advisors' answers. Cancelling the wait leaves them working:
   * clients cancel slow tool calls, and the agent calls again. The round
   * stops when the turn that asked it ends (`onThreadSettled`).
   */
  async askAnswers(threadId: string, id: string, signal: AbortSignal): Promise<string> {
    const ask = this.asks.get(id);
    if (ask !== undefined && ask.threadId === threadId) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled: (() => void) | undefined;
      try {
        // Wait a while at a time: a tool call cannot stay silent for long,
        // and advisors may take longer than that while still working.
        const notes = await Promise.race([
          ask.result,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), this.timing.answersWaitMs);
            cancelled = () => resolve(null);
            signal.addEventListener("abort", cancelled, { once: true });
          }),
        ]);
        if (notes === null) {
          const round = this.deps.rounds.get(id);
          return askProgressText(round?.advisors ?? [], id, Date.now());
        }
        if (ask.run.signal.aborted) throw new Error("The advisors were stopped.");
        return askAnswersText(notes, roundDirective(id));
      } finally {
        clearTimeout(timer);
        if (cancelled !== undefined) signal.removeEventListener("abort", cancelled);
      }
    }
    // After a plugin reload, a finished round can still be read back.
    const round = this.deps.rounds.get(id);
    if (round !== null && round.moaThreadId === threadId && round.finishedAt !== null) {
      return askAnswersText(
        round.advisors.map((entry) => ({ label: entry.label, text: entry.answer, error: entry.error })),
        roundDirective(id),
      );
    }
    throw new Error(
      "That advisor round is not running any more (the plugin may have reloaded). Call moa_ask again if you still need the advisors.",
    );
  }

  /** Abort runs whose bridge went away and forget long-finished ones. */
  sweep(now = Date.now()): void {
    for (const [id, run] of this.runs) {
      if (!run.done && now - run.lastPollAt > ORPHAN_MS) run.controller.abort();
      if (run.finishedAt !== null && now - run.finishedAt > FINISHED_TTL_MS) {
        this.runs.delete(id);
        if (this.activeByThread.get(run.moaThreadId) === run) {
          this.activeByThread.delete(run.moaThreadId);
        }
      }
    }
  }

  dispose(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  // ── the turn ────────────────────────────────────────────────────────────

  private async execute(run: Run, args: StartArgs): Promise<void> {
    run.signal.addEventListener("abort", () => void this.stopWorkers(run), {
      once: true,
    });
    try {
      const outcome = await this.runTurn(run, args);
      run.push({ type: "done", ...outcome });
    } catch (error) {
      run.push(
        run.signal.aborted
          ? { type: "done", status: "interrupted" }
          : { type: "done", status: "failed", error: errorMessage(error) },
      );
    } finally {
      // A failed turn can leave workers mid-turn; never leave them running.
      if (run.busyWorkers.size > 0) await this.stopWorkers(run);
    }
  }

  private async runTurn(
    run: Run,
    args: StartArgs,
  ): Promise<{ status: TurnStatus; error?: string }> {
    const sdk = this.deps.sdk();
    const store = await this.deps.loadStore();
    const preset = findPreset(store, args.presetId);
    if (preset === null) {
      throw new Error(
        `There is no Mixture of Agents preset named "${args.presetId}". Pick a preset in the model picker, or create one under Settings → Plugins → MoA Provider.`,
      );
    }
    const thread = await sdk.threads.get({ threadId: run.moaThreadId });
    if (!("environmentId" in thread) || thread.environmentId === null) {
      throw new Error("The MoA thread has no environment yet.");
    }
    const advisors = advisorSlots(preset);
    const ctx: TurnContext = {
      run,
      projectId: thread.projectId,
      environmentId: thread.environmentId,
      permissionMode: args.permissionMode,
      state: await this.loadThreadState(run.moaThreadId),
      userText: promptText(args.input),
      preset,
      advisors,
      embedPanels: true,
    };

    const previous = ctx.state.history.at(-1) ?? null;
    const { notes } = await this.runRound(ctx, {
      round: 0,
      question: null,
      idleMs: await this.deps.advisorIdleMs(),
      maxMs: this.timing.roundMaxMs,
      signal: run.signal,
      prompt: (fresh) =>
        fresh
          ? advisorFirstPrompt(ctx.state.history, ctx.userText)
          : advisorFollowUpPrompt(previous, ctx.userText),
    });
    if (run.signal.aborted) return { status: "interrupted" };

    const result = await this.aggregate(ctx, preset.aggregator, args.input, notes);
    if (result.answer !== null || result.status === "completed") {
      ctx.state.history = [
        ...ctx.state.history,
        { user: ctx.userText, answer: result.answer ?? "" },
      ].slice(-HISTORY_TURNS);
    }
    await this.saveThreadState(run.moaThreadId, ctx.state);
    return result.error === undefined
      ? { status: result.status }
      : { status: result.status, error: result.error };
  }

  /** One mid-turn round: every advisor, with the aggregator's question. */
  private async consultRound(
    run: Run,
    consultation: Consultation,
    question: string,
    callSignal: AbortSignal,
  ): Promise<string> {
    const { ctx, mirror } = consultation;
    consultation.rounds += 1;
    // BB stores the aggregator's events, including this very `moa_consult`
    // call, before the call reaches the plugin. Mirror them before the panel
    // so the call's row comes first and the panel is followed directly by its
    // status line (which keeps it in view when the turn folds).
    const recorded = await this.latestSeq(consultation.aggregatorThreadId).catch(() => 0);
    const deadline = Date.now() + MIRROR_CATCH_UP_MS;
    while (consultation.mirroredSeq < recorded && Date.now() < deadline && !run.signal.aborted) {
      await sleep(this.timing.aggregatorPollMs, run.signal);
    }
    const progress = mirror.progressDigest();
    const { notes } = await this.runRound(ctx, {
      round: consultation.rounds,
      question,
      idleMs: await this.deps.advisorIdleMs(),
      // `moa_consult` blocks a tool call, which cannot stay silent for long.
      maxMs: this.timing.consultMaxMs,
      signal: AbortSignal.any([run.signal, callSignal]),
      prompt: (fresh) =>
        fresh
          ? `${advisorFirstPrompt(ctx.state.history, ctx.userText)}\n\n${advisorConsultPrompt(question, progress)}`
          : advisorConsultPrompt(question, progress),
    });
    await this.saveThreadState(run.moaThreadId, ctx.state);
    return consultResultText(notes);
  }

  /**
   * Ask every advisor at once. The round is recorded for its panel, which
   * the MoA thread embeds as a `::moa-advisors` message when the round starts
   * and which updates live as each advisor settles.
   */
  private async runRound(
    ctx: TurnContext,
    args: {
      round: number;
      question: string | null;
      idleMs: number;
      maxMs: number;
      signal: AbortSignal;
      prompt: (fresh: boolean) => string;
      /** Called once the round is recorded, so its panel can load. */
      onStarted?: (id: string) => void;
    },
  ): Promise<{ notes: AdvisorNote[]; id: string | null }> {
    const { run } = ctx;
    if (ctx.advisors.length === 0) return { notes: [], id: null };
    const labels = await Promise.all(ctx.advisors.map(({ slot }) => this.slotLabel(slot)));
    const startedAt = Date.now();
    const record: AdvisorRound = {
      id: roundId(run.id, args.round),
      moaThreadId: run.moaThreadId,
      round: args.round,
      question: args.question,
      startedAt,
      finishedAt: null,
      advisors: ctx.advisors.map(({ slot }, index) => ({
        label: labels[index]!,
        providerId: slot.providerId,
        model: slot.model,
        reasoningLevel: slot.reasoningLevel,
        status: "running",
        startedAt,
        finishedAt: null,
        answer: null,
        error: null,
        workerThreadId: null,
      })),
    };
    this.commitRound(record);
    args.onStarted?.(record.id);
    if (ctx.embedPanels) {
      const key = { providerItemId: `panel-${record.id}` };
      const text = roundDirective(record.id);
      run.deltas([
        { kind: "item.open", key, item: { type: "agentMessage", text: "" } },
        { kind: "item.textDelta", key, channel: "agentMessage", text },
        { kind: "item.textClose", key, channel: "agentMessage", text },
      ]);
    }
    // Streaming progress is saved at most every progressCommitMs; settled
    // advisors are saved at once.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const commit = () => {
      if (pending !== null) clearTimeout(pending);
      pending = null;
      this.commitRound(record);
    };
    const commitSoon = () => {
      pending ??= setTimeout(commit, this.timing.progressCommitMs);
    };
    const notes = await Promise.all(
      ctx.advisors.map((advisor, index) =>
        this.askAdvisor(ctx, advisor, {
          entry: record.advisors[index]!,
          commit,
          commitSoon,
          idleMs: args.idleMs,
          maxMs: args.maxMs,
          signal: args.signal,
          prompt: args.prompt,
        }),
      ),
    );
    record.finishedAt = Date.now();
    commit();
    if (ctx.embedPanels && !run.signal.aborted) {
      // Right after the panel, so a folded turn keeps the panel in view.
      const handoff = roundHandoffText({
        round: args.round,
        answered: record.advisors.filter((entry) => entry.status === "answered").length,
        total: record.advisors.length,
        aggregator: await this.slotLabel(ctx.preset.aggregator),
      });
      const handoffKey = { providerItemId: `handoff-${record.id}` };
      run.deltas([
        { kind: "item.open", key: handoffKey, item: { type: "agentMessage", text: "" } },
        { kind: "item.textDelta", key: handoffKey, channel: "agentMessage", text: handoff },
        { kind: "item.textClose", key: handoffKey, channel: "agentMessage", text: handoff },
      ]);
    }
    return { notes, id: record.id };
  }

  /** Save a round and tell open panels to refresh. Never fails the turn. */
  private commitRound(round: AdvisorRound): void {
    try {
      this.deps.rounds.save(round);
      this.deps.publishRound(round.id);
    } catch (error) {
      this.deps.log.warn(`saving advisor round ${round.id} failed: ${errorMessage(error)}`);
    }
  }

  /** Ask one advisor and record the outcome in its round entry. */
  private async askAdvisor(
    ctx: TurnContext,
    advisor: AdvisorSlot,
    args: {
      entry: AdvisorEntry;
      commit: () => void;
      /** Save soon, for streaming progress. */
      commitSoon: () => void;
      idleMs: number;
      maxMs: number;
      signal: AbortSignal;
      prompt: (fresh: boolean) => string;
    },
  ): Promise<AdvisorNote> {
    const { run } = ctx;
    const { slot, workerKey } = advisor;
    const { entry } = args;
    const stream = new AdvisorStream({
      workspace: await this.workspacePath(ctx.environmentId),
      home: homedir(),
    });
    const label = entry.label;
    let note: AdvisorNote;
    let status: AdvisorStatus;
    try {
      const existing = ctx.state.advisors[workerKey] ?? null;
      const worker = await this.sendToWorker(ctx, {
        role: "advisor",
        slot,
        label,
        existing,
        input: (fresh) => [{ type: "text", text: args.prompt(fresh) }],
      });
      ctx.state.advisors[workerKey] = worker.threadId;
      entry.workerThreadId = worker.threadId;
      args.commit();
      const result = await this.followTurn(run, worker.threadId, worker.since, {
        pollMs: this.timing.advisorPollMs,
        idleMs: args.idleMs,
        maxMs: args.maxMs,
        signal: args.signal,
        onEvents: (rows) => {
          if (!stream.apply(rows)) return;
          entry.answer = stream.text;
          entry.activity = stream.activity;
          args.commitSoon();
        },
        onInteraction: (interaction) => this.declineForAdvisor(worker.threadId, interaction),
      });
      if (
        result.status === "timeout" ||
        (result.status === "interrupted" && !run.signal.aborted)
      ) {
        // Out of time, or the consult call itself was cancelled.
        await this.stopThread(worker.threadId);
        run.busyWorkers.delete(worker.threadId);
      }
      // Keep what a cut-off advisor had written so far.
      const written = result.lastAgentMessage ?? stream.text;
      if (result.status === "timeout") {
        status = "timed-out";
        note = {
          label,
          text: written,
          error:
            result.timeoutReason === "idle"
              ? `No progress for ${formatSeconds(args.idleMs)}, so it was stopped.`
              : `Still working after ${formatSeconds(args.maxMs)}, so it was stopped.`,
        };
      } else if (result.status === "completed" && written !== null) {
        status = "answered";
        note = { label, text: written, error: null };
      } else {
        status = result.status === "interrupted" ? "stopped" : "failed";
        note = {
          label,
          text: written,
          error:
            result.error ??
            (result.status !== "interrupted"
              ? `The advisor turn ended as ${result.status}.`
              : run.signal.aborted
                ? "Stopped with the rest of the round."
                : // Not by the plugin: someone stopped the worker thread.
                  "Its thread was stopped before it finished."),
        };
      }
    } catch (error) {
      status = run.signal.aborted ? "stopped" : "failed";
      note = { label, text: stream.text, error: errorMessage(error) };
    }
    entry.status = status;
    entry.answer = note.text;
    entry.activity = null;
    entry.error = status === "answered" ? null : note.error;
    entry.finishedAt = Date.now();
    args.commit();
    // A partial answer still reaches the aggregator, marked as such.
    return status === "answered" || note.text === null
      ? note
      : { ...note, text: `${note.text}\n\n[This advisor was cut off before finishing.]` };
  }

  /** Run the aggregator's turn, mirroring its timeline into the MoA thread. */
  private async aggregate(
    ctx: TurnContext,
    slot: Slot,
    input: Input,
    notes: readonly AdvisorNote[],
  ): Promise<{ status: TurnStatus; error?: string; answer: string | null }> {
    const { run, state } = ctx;
    const signature = slotSignature(slot);
    const previous = state.aggregator;
    const existing = previous?.signature === signature ? previous.threadId : null;
    if (previous !== null && existing === null) {
      // The preset's aggregator changed: retire the old worker.
      void this.deps
        .sdk()
        .threads.archive({ threadId: previous.threadId })
        .catch(() => undefined);
    }
    const consult = consultsMidTurn(ctx.preset);
    if (existing !== null && (previous?.consult ?? false) !== consult) {
      // The tool set is fixed per provider session: flag the worker, then
      // release its session so the next message resumes it with the change.
      await this.deps.sdk().threads.updatePluginMetadata({
        threadId: existing,
        pluginId: MOA_PLUGIN_ID,
        set: { consult },
      });
      await this.stopThread(existing);
    }
    const notesText = advisorNotesBlock(notes);
    const label = await this.slotLabel(slot);
    const worker = await this.sendToWorker(ctx, {
      role: "aggregator",
      slot,
      label,
      existing,
      metadata: { consult },
      input: (fresh) => {
        const preamble = fresh ? aggregatorPreamble(state.history) : "";
        return [
          ...(preamble === "" ? [] : [{ type: "text", text: preamble }]),
          ...input,
          ...(notesText === "" ? [] : [{ type: "text", text: notesText }]),
        ];
      },
    });
    state.aggregator = { signature, threadId: worker.threadId, consult };
    await this.saveThreadState(run.moaThreadId, state);

    const mirror = new AggregatorMirror();
    const consultation: Consultation | null = consult
      ? {
          ctx,
          aggregatorThreadId: worker.threadId,
          mirror,
          toolsSinceConsult: 0,
          nudgedAt: null,
          inFlight: null,
          rounds: 0,
          mirroredSeq: worker.since,
        }
      : null;
    run.consultation = consultation;
    if (consultation !== null) this.byAggregator.set(worker.threadId, run);
    const result = await this.followTurn(run, worker.threadId, worker.since, {
      pollMs: this.timing.aggregatorPollMs,
      idleMs: null,
      maxMs: null,
      onEvents: (rows, cursor) => {
        run.deltas(rows.flatMap((row) => mirror.translate(row)));
        if (consultation !== null) {
          this.countToolCalls(consultation, rows);
          consultation.mirroredSeq = cursor;
        }
      },
      onInteraction: async (interaction) => {
        const requestId = `${run.id}:${interaction.id}`;
        if (run.interactions.has(requestId)) return;
        run.interactions.set(requestId, {
          threadId: worker.threadId,
          interactionId: interaction.id,
        });
        const decision = consultApprovalDecision(interaction.payload);
        if (decision !== null) {
          await this.deps
            .sdk()
            .threads.interactions.resolve({
              threadId: worker.threadId,
              interactionId: interaction.id,
              resolution: { decision, grantedPermissions: null } as never,
            })
            .catch((error: unknown) =>
              this.deps.log.warn(`auto-approving moa_consult failed: ${errorMessage(error)}`),
            );
          return;
        }
        run.push({ type: "interaction", requestId, payload: interaction.payload });
      },
    });
    run.consultation = null;
    if (this.byAggregator.get(worker.threadId) === run) {
      this.byAggregator.delete(worker.threadId);
    }
    const status: TurnStatus =
      result.status === "timeout" ? "failed" : result.status;
    if (status !== "completed") run.deltas(mirror.closeOpenItems(status));
    return {
      status,
      ...(result.error === undefined ? {} : { error: result.error }),
      answer: mirror.lastAnswer ?? result.lastAgentMessage,
    };
  }

  /**
   * Count the aggregator's tool calls and, for "every-n", send a check-in
   * once N have passed since the advisors were last asked. It goes out as a
   * BB steer, right after a tool call finished: providers that inject steers
   * take it at the next step, and the ACP bridge cancels the running prompt
   * and continues with it, so nothing is cut off mid-command.
   */
  private countToolCalls(
    consultation: Consultation,
    rows: readonly { type: string; data: unknown }[],
  ): void {
    const completed = rows.filter((row) => isToolCompletion(row)).length;
    if (completed === 0) return;
    consultation.toolsSinceConsult += completed;
    const { preset, run } = consultation.ctx;
    if (preset.fanout !== "every-n" || consultation.inFlight !== null) return;
    // A check-in lands a step or two late and may need a schema lookup
    // first, so an unanswered one holds off the next for twice as long.
    const due =
      consultation.nudgedAt === null
        ? preset.fanoutEvery
        : consultation.nudgedAt + preset.fanoutEvery * 2;
    if (consultation.toolsSinceConsult < due) return;
    consultation.nudgedAt = consultation.toolsSinceConsult;
    const count = consultation.toolsSinceConsult;
    void this.deps
      .sdk()
      .threads.send({
        threadId: consultation.aggregatorThreadId,
        mode: "steer",
        input: [{ type: "text", text: consultNudge(count) }] as never,
      })
      .catch((error: unknown) => {
        // The turn ended first: no check-in is needed any more.
        if (!run.signal.aborted) {
          this.deps.log.debug(`check-in not delivered: ${errorMessage(error)}`);
        }
      });
  }

  // ── worker threads ──────────────────────────────────────────────────────

  /**
   * Start a turn on the slot's worker: reuse the existing thread when it is
   * still usable, otherwise spawn a hidden one owned by the MoA thread.
   * Returns the event sequence to follow the new turn from.
   */
  private async sendToWorker(
    ctx: TurnContext,
    args: {
      role: "advisor" | "aggregator";
      slot: Slot;
      label: string;
      existing: string | null;
      /** Extra thread metadata for a newly spawned worker. */
      metadata?: Record<string, boolean | string>;
      input: (fresh: boolean) => Input;
    },
  ): Promise<{ threadId: string; since: number }> {
    const sdk = this.deps.sdk();
    const { slot } = args;
    const permissionMode = await this.clampPermission(
      slot.providerId,
      ctx.permissionMode,
    );
    if (args.existing !== null) {
      const current = await sdk.threads
        .get({ threadId: args.existing })
        .catch(() => null);
      if (current !== null && current.archivedAt === null && current.deletedAt === null) {
        if (current.status !== "idle" && current.status !== "error") {
          await this.stopThread(args.existing);
        }
        const since = await this.latestSeq(args.existing);
        ctx.run.busyWorkers.add(args.existing);
        await sdk.threads.send({
          threadId: args.existing,
          mode: "start",
          input: args.input(false) as never,
          model: slot.model,
          reasoningLevel: slot.reasoningLevel,
          ...(slot.serviceTier === undefined ? {} : { serviceTier: slot.serviceTier }),
          permissionMode,
        });
        return { threadId: args.existing, since };
      }
    }
    const spawned = await sdk.threads.spawn({
      projectId: ctx.projectId,
      environment: { type: "reuse", environmentId: ctx.environmentId },
      providerId: slot.providerId,
      model: slot.model,
      reasoningLevel: slot.reasoningLevel,
      ...(slot.serviceTier === undefined ? {} : { serviceTier: slot.serviceTier }),
      permissionMode,
      input: args.input(true) as never,
      title: `MoA ${args.role} · ${args.label}`,
      visibility: "hidden",
      lifecycleOwnerThreadId: ctx.run.moaThreadId,
      pluginMetadata: {
        role: args.role,
        moaThreadId: ctx.run.moaThreadId,
        ...args.metadata,
      },
    });
    ctx.run.busyWorkers.add(spawned.id);
    return { threadId: spawned.id, since: 0 };
  }

  /**
   * Follow a worker's timeline from `since` until its top-level turn
   * completes. Nested sub-agent turns share the event stream, so completion
   * is matched on the first top-level turn's id.
   */
  private async followTurn(
    run: Run,
    threadId: string,
    since: number,
    options: {
      pollMs: number;
      /** Give up after this long without a new event (null: never). */
      idleMs: number | null;
      /** Give up after this long in all (null: never). */
      maxMs: number | null;
      /** Stops following early; defaults to the run's own signal. */
      signal?: AbortSignal;
      /** Each batch of events, with the sequence it reached. */
      onEvents?: (rows: { type: string; data: unknown }[], cursor: number) => void;
      onInteraction: (interaction: {
        id: string;
        payload: Record<string, unknown>;
      }) => void | Promise<void>;
    },
  ): Promise<FollowResult> {
    const sdk = this.deps.sdk();
    const signal = options.signal ?? run.signal;
    const startedAt = Date.now();
    const deadline = options.maxMs === null ? Number.POSITIVE_INFINITY : startedAt + options.maxMs;
    let lastProgressAt = startedAt;
    let cursor = since;
    let turnId: string | null = null;
    let lastAgentMessage: string | null = null;
    let nextInteractionCheck = 0;
    let nextStatusCheck = Date.now() + this.timing.statusPollMs;

    while (true) {
      if (signal.aborted) return { status: "interrupted", lastAgentMessage };
      if (Date.now() > deadline) {
        return { status: "timeout", timeoutReason: "limit", lastAgentMessage };
      }
      if (options.idleMs !== null && Date.now() - lastProgressAt > options.idleMs) {
        return { status: "timeout", timeoutReason: "idle", lastAgentMessage };
      }

      const rows = await sdk.threads.events.list({
        threadId,
        afterSeq: String(cursor),
        limit: String(EVENT_PAGE),
        signal,
      });
      if (rows.length > 0) lastProgressAt = Date.now();
      const relevant: { type: string; data: unknown }[] = [];
      let completed: FollowResult | null = null;
      for (const row of rows) {
        cursor = Math.max(cursor, Number(row.seq));
        const scope = row.scope as { kind?: string; turnId?: string } | undefined;
        const data = row.data as Record<string, unknown>;
        if (row.type === "turn/started" && turnId === null && data.parentToolCallId === undefined) {
          turnId = scope?.turnId ?? null;
        }
        if (row.type === "item/completed") {
          const item = data.item as Record<string, unknown> | undefined;
          if (
            item?.type === "agentMessage" &&
            item.parentToolCallId === undefined &&
            typeof item.text === "string" &&
            item.text.trim() !== ""
          ) {
            lastAgentMessage = item.text;
          }
        }
        if (row.type === "turn/completed" && (turnId === null || scope?.turnId === turnId)) {
          const status = data.status as TurnStatus;
          const error = (data.error as { message?: string } | undefined)?.message;
          completed = {
            status,
            ...(error === undefined ? {} : { error }),
            lastAgentMessage,
          };
          break;
        }
        relevant.push({ type: row.type, data: row.data });
      }
      options.onEvents?.(relevant, cursor);
      if (completed !== null) {
        run.busyWorkers.delete(threadId);
        return completed;
      }
      if (rows.length >= EVENT_PAGE) continue;

      const now = Date.now();
      if (now >= nextInteractionCheck) {
        nextInteractionCheck = now + this.timing.interactionPollMs;
        const pending = await sdk.threads.interactions
          .list({ threadId, signal })
          .catch(() => []);
        for (const interaction of pending) {
          if (interaction.status !== "pending") continue;
          await options.onInteraction({
            id: interaction.id,
            payload: interaction.payload as unknown as Record<string, unknown>,
          });
        }
      }
      if (now >= nextStatusCheck) {
        nextStatusCheck = now + this.timing.statusPollMs;
        // A worker that failed before starting a turn never completes one.
        const current = await sdk.threads.get({ threadId }).catch(() => null);
        const settled =
          current !== null &&
          (current.status === "error" ||
            (current.status === "idle" && current.queuedMessageCount === 0));
        if (settled && turnId === null && now - startedAt > this.timing.startGraceMs) {
          const tail = await sdk.threads.events.list({
            threadId,
            afterSeq: String(cursor),
            limit: "1",
          });
          if (tail.length === 0) {
            run.busyWorkers.delete(threadId);
            return {
              status: current!.status === "error" ? "failed" : "completed",
              error:
                current!.status === "error"
                  ? `The ${threadId} worker failed to start. Open it to see why.`
                  : undefined,
              lastAgentMessage,
            };
          }
        }
      }
      await sleep(options.pollMs, signal);
    }
  }

  /** Advisors must never block: decline approvals and questions outright. */
  private async declineForAdvisor(
    threadId: string,
    interaction: { id: string; payload: Record<string, unknown> },
  ): Promise<void> {
    const threads = this.deps.sdk().threads;
    try {
      if (interaction.payload.kind === "approval") {
        await threads.interactions.resolve({
          threadId,
          interactionId: interaction.id,
          resolution: { decision: "deny" } as never,
        });
      } else {
        await threads.interactions.cancel({ threadId, interactionId: interaction.id });
      }
    } catch (error) {
      this.deps.log.warn(`declining ${interaction.id} failed: ${errorMessage(error)}`);
    }
  }

  private async stopWorkers(run: Run): Promise<void> {
    await Promise.all([...run.busyWorkers].map((threadId) => this.stopThread(threadId)));
    run.busyWorkers.clear();
  }

  private async stopThread(threadId: string): Promise<void> {
    const sdk = this.deps.sdk();
    try {
      await sdk.threads.stop({ threadId });
      await sdk.threads
        .wait({ threadId, status: "idle", timeoutMs: STOP_WAIT_MS })
        .catch(() => undefined);
    } catch (error) {
      this.deps.log.warn(`stopping worker ${threadId} failed: ${errorMessage(error)}`);
    }
  }

  private async latestSeq(threadId: string): Promise<number> {
    const rows = await this.deps
      .sdk()
      .threads.events.list({ threadId, order: "desc", limit: "1" });
    return rows.length === 0 ? 0 : Number(rows[0]!.seq);
  }

  /** Where an environment's files live; null when unknown. */
  private async workspacePath(environmentId: string): Promise<string | null> {
    const known = this.workspacePaths.get(environmentId);
    if (known !== undefined) return known;
    try {
      const { path } = await this.deps.sdk().environments.get({ environmentId });
      if (path !== null) this.workspacePaths.set(environmentId, path);
      return path;
    } catch (error) {
      this.deps.log.warn(`could not look up environment ${environmentId}: ${errorMessage(error)}`);
      return null;
    }
  }

  // ── provider facts ──────────────────────────────────────────────────────

  private async providerFacts(providerId: string): Promise<ProviderFacts | null> {
    const cached = this.providerCache.get(providerId);
    if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.facts;
    try {
      const sdk = this.deps.sdk();
      const [providers, catalog] = await Promise.all([
        sdk.providers.list(),
        sdk.providers.models({ providerId }),
      ]);
      const info = providers.find((provider) => provider.id === providerId);
      if (info === undefined) return null;
      const facts: ProviderFacts = {
        displayName: info.displayName,
        permissionModes: [...info.capabilities.permissionModes],
        models: new Map(catalog.models.map((model) => [model.id, model.displayName])),
      };
      this.providerCache.set(providerId, { at: Date.now(), facts });
      return facts;
    } catch {
      return null;
    }
  }

  private async slotLabel(slot: Slot): Promise<string> {
    const facts = await this.providerFacts(slot.providerId);
    const provider = facts?.displayName ?? slot.providerId;
    const model = facts?.models.get(slot.model) ?? slot.model;
    return `${provider} · ${model}`;
  }

  /** The MoA thread's mode when the worker's provider supports it. */
  private async clampPermission(
    providerId: string,
    requested: PermissionMode,
  ): Promise<PermissionMode> {
    const modes = (await this.providerFacts(providerId))?.permissionModes ?? [];
    if (modes.length === 0 || modes.includes(requested)) return requested;
    const order: PermissionMode[] = ["accept-edits", "auto", "full"];
    return order.find((mode) => modes.includes(mode)) ?? requested;
  }

  // ── storage ─────────────────────────────────────────────────────────────

  private async loadThreadState(threadId: string): Promise<ThreadState> {
    const stored = await this.deps.kv.get<ThreadState>(`thread:${threadId}`);
    return stored === null || stored === undefined
      ? structuredClone(EMPTY_THREAD_STATE)
      : { ...structuredClone(EMPTY_THREAD_STATE), ...stored };
  }

  private async saveThreadState(threadId: string, state: ThreadState): Promise<void> {
    await this.deps.kv.set(`thread:${threadId}`, state);
  }

  async forgetThread(threadId: string): Promise<void> {
    await this.deps.kv.delete(`thread:${threadId}`);
    this.deps.rounds.deleteThread(threadId);
  }
}
