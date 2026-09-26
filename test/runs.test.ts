// The server orchestrator against a scripted stand-in for `bb.sdk`: each
// fake worker thread plays a turn out as stored timeline events.
import { describe, expect, it } from "vitest";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import type { Preset, PresetStore } from "../src/presets.js";
import { memoryRoundStore } from "../src/rounds.js";
import { MoaRuns } from "../src/runs.js";
import type { LogEntry, StartArgs } from "../src/wire.js";

type Row = { seq: number; type: string; scope: { kind: string; turnId?: string }; data: Record<string, unknown> };

interface Behaviour {
  /** Text the worker answers with; null never finishes (until stopped). */
  answer: string | null;
  /** Raise an approval and wait for it before answering. */
  approval?: boolean;
  /** Payload of that approval (a command approval by default). */
  approvalPayload?: Record<string, unknown>;
  /** Commands the worker runs (one per 5ms) before answering. */
  tools?: number;
  /** Stream an answer in chunks, one every `everyMs`, then finish or go quiet. */
  stream?: { chunks: string[]; everyMs: number; then: "finish" | "silence" };
}

interface FakeThread {
  id: string;
  providerId: string;
  status: "idle" | "active" | "error";
  archivedAt: number | null;
  events: Row[];
  inputs: unknown[][];
  interactions: { id: string; status: string; payload: Record<string, unknown> }[];
  turn: number;
}

function createFakeSdk(behaviours: Record<string, Behaviour>) {
  const threads = new Map<string, FakeThread>();
  /** Status of the MoA and asking threads, "active" unless a test sets it. */
  const statuses = new Map<string, string>();
  const calls = { spawn: [] as Record<string, unknown>[], send: [] as Record<string, unknown>[], steer: [] as Record<string, unknown>[], stop: [] as string[], archive: [] as string[], resolve: [] as unknown[], metadata: [] as Record<string, unknown>[] };
  let seq = 0;
  const push = (thread: FakeThread, type: string, data: Record<string, unknown>) => {
    seq += 1;
    thread.events.push({ seq, type, scope: { kind: "turn", turnId: `${thread.id}-t${thread.turn}` }, data });
  };
  const finish = (thread: FakeThread, text: string) => {
    push(thread, "item/started", { item: { type: "agentMessage", id: `${thread.id}-m${thread.turn}`, text: "" } });
    push(thread, "item/completed", { item: { type: "agentMessage", id: `${thread.id}-m${thread.turn}`, text } });
    push(thread, "turn/completed", { status: "completed" });
    thread.status = "idle";
  };
  const play = (thread: FakeThread, input: unknown[]) => {
    thread.inputs.push(input);
    thread.turn += 1;
    thread.status = "active";
    const behaviour = behaviours[thread.providerId] ?? { answer: "ok" };
    setTimeout(async () => {
      push(thread, "turn/started", {});
      for (let index = 0; index < (behaviour.tools ?? 0); index += 1) {
        const id = `${thread.id}-c${thread.turn}-${index}`;
        const item = { type: "commandExecution", id, command: `echo ${index}`, cwd: "/w", status: "completed", approvalStatus: null, aggregatedOutput: `${index}\n`, exitCode: 0 };
        push(thread, "item/started", { item: { ...item, status: "pending" } });
        push(thread, "item/completed", { item });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (behaviour.stream) {
        const id = `${thread.id}-s${thread.turn}`;
        push(thread, "item/started", { item: { type: "reasoning", id: `${id}-r`, summary: [], content: [] } });
        push(thread, "item/reasoning/textDelta", { itemId: `${id}-r`, delta: "Weighing the options in /work/pantry/src." });
        await new Promise((resolve) => setTimeout(resolve, behaviour.stream!.everyMs));
        push(thread, "item/started", { item: { type: "agentMessage", id, text: "" } });
        for (const chunk of behaviour.stream.chunks) {
          await new Promise((resolve) => setTimeout(resolve, behaviour.stream!.everyMs));
          if (thread.status !== "active") return;
          push(thread, "item/agentMessage/delta", { itemId: id, delta: chunk });
        }
        if (behaviour.stream.then === "finish") finish(thread, behaviour.stream.chunks.join(""));
        return;
      }
      if (behaviour.approval) {
        thread.interactions.push({
          id: `int-${thread.id}`,
          status: "pending",
          payload: behaviour.approvalPayload ?? { kind: "approval", subject: "command" },
        });
        return;
      }
      if (behaviour.answer !== null) finish(thread, behaviour.answer);
    }, 5);
  };
  const sdk = {
    environments: {
      async get() {
        return { path: "/work/pantry" };
      },
    },
    threads: {
      async get({ threadId }: { threadId: string }) {
        if (threadId === "moa-1" || threadId.startsWith("thr_")) {
          return { id: threadId, projectId: "proj", environmentId: "env", status: statuses.get(threadId) ?? "active", archivedAt: null, deletedAt: null };
        }
        const thread = threads.get(threadId);
        if (!thread) throw new Error("no thread");
        return { id: thread.id, projectId: "proj", environmentId: "env", status: thread.status, archivedAt: thread.archivedAt, deletedAt: null };
      },
      async spawn(args: Record<string, unknown>) {
        calls.spawn.push(args);
        const thread: FakeThread = { id: `w${threads.size + 1}`, providerId: String(args.providerId), status: "idle", archivedAt: null, events: [], inputs: [], interactions: [], turn: 0 };
        threads.set(thread.id, thread);
        play(thread, args.input as unknown[]);
        return { id: thread.id };
      },
      async send(args: Record<string, unknown>) {
        const thread = threads.get(String(args.threadId))!;
        if (args.mode === "steer") {
          if (thread.status !== "active") throw new Error("No active turn to steer");
          calls.steer.push(args);
          return { ok: true, delivery: "sent" };
        }
        calls.send.push(args);
        play(threads.get(String(args.threadId))!, args.input as unknown[]);
        return { ok: true, delivery: "sent" };
      },
      async stop({ threadId }: { threadId: string }) {
        calls.stop.push(threadId);
        const thread = threads.get(threadId)!;
        if (thread.status === "active") push(thread, "turn/completed", { status: "interrupted" });
        thread.status = "idle";
        return { ok: true };
      },
      async wait() {
        return {};
      },
      async updatePluginMetadata(args: Record<string, unknown>) {
        calls.metadata.push(args);
        return {};
      },
      async archive({ threadId }: { threadId: string }) {
        calls.archive.push(threadId);
        threads.get(threadId)!.archivedAt = Date.now();
        return {};
      },
      events: {
        async list({ threadId, afterSeq, order, limit }: { threadId: string; afterSeq?: string; order?: string; limit?: string }) {
          if (Number(limit ?? 100) > 100) throw new Error("HTTP 400: Thread event limit cannot exceed 100");
          const rows = threads.get(threadId)?.events ?? [];
          if (order === "desc") return rows.slice(-Number(limit ?? 1)).reverse();
          return rows.filter((row) => row.seq > Number(afterSeq ?? 0)).slice(0, Number(limit ?? 100));
        },
      },
      interactions: {
        async list({ threadId }: { threadId: string }) {
          return threads.get(threadId)?.interactions ?? [];
        },
        async resolve(args: { threadId: string; interactionId: string; resolution: unknown }) {
          calls.resolve.push(args);
          const thread = threads.get(args.threadId)!;
          const interaction = thread.interactions.find((entry) => entry.id === args.interactionId)!;
          interaction.status = "resolved";
          finish(thread, "approved and done");
          return interaction;
        },
        async cancel() {
          return {};
        },
      },
    },
    providers: {
      async list() {
        return ["claude-code", "codex", "gemini"].map((id) => ({
          id,
          displayName: id.toUpperCase(),
          available: true,
          capabilities: { permissionModes: ["accept-edits", "auto", "full"] },
        }));
      },
      async models() {
        return { models: [{ id: "m1", displayName: "Model One" }] };
      },
    },
  };
  /** Record an event on a worker, as its provider would. */
  const record = (threadId: string, type: string, data: Record<string, unknown>) =>
    push(threads.get(threadId)!, type, data);
  return { sdk, threads, calls, record, statuses };
}

const preset = (overrides: Partial<Preset> = {}): Preset => ({
  id: "default",
  name: "Default",
  description: "",
  aggregator: { providerId: "claude-code", model: "m1", reasoningLevel: "high" },
  advisors: [
    { providerId: "codex", model: "m1", reasoningLevel: "medium" },
    { providerId: "gemini", model: "m1", reasoningLevel: "medium" },
  ],
  advisorsEnabled: true,
  fanout: "message",
  fanoutEvery: 5,
  ...overrides,
});

function setup(
  behaviours: Record<string, Behaviour>,
  store: PresetStore,
  advisorTimeoutMs = 2_000,
  timing: Record<string, number> = {},
) {
  const fake = createFakeSdk(behaviours);
  const kv = new Map<string, unknown>();
  const rounds = memoryRoundStore();
  const published: string[] = [];
  const runs = new MoaRuns({
    sdk: () => fake.sdk as never,
    loadStore: async () => store,
    advisorIdleMs: async () => advisorTimeoutMs,
    kv: {
      get: async (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : null),
      set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
      delete: async (key: string) => void kv.delete(key),
      list: async () => [],
    } as never,
    log: { debug() {}, info() {}, warn() {}, error() {} } as never,
    rounds,
    publishRound: (id) => published.push(id),
    timing: {
      advisorPollMs: 5,
      aggregatorPollMs: 5,
      interactionPollMs: 5,
      statusPollMs: 50,
      startGraceMs: 500,
      progressCommitMs: 5,
      ...timing,
    },
  });
  // Every saved state, to see progress while advisors work.
  const saves: { status: string; answer: string | null; activity?: string | null }[][] = [];
  const save = rounds.save.bind(rounds);
  rounds.save = (round) => {
    saves.push(round.advisors.map(({ status, answer, activity }) => ({ status, answer, activity })));
    save(round);
  };
  return { ...fake, runs, kv, rounds, published, saves };
}

const START: StartArgs = {
  op: "start",
  presetId: "default",
  permissionMode: "auto",
  input: [{ type: "text", text: "Fix the bug", mentions: [] }],
};

/** Drain a run the way the bridge does, answering interactions via `answer`. */
async function drain(
  runs: MoaRuns,
  runId: string,
  answer?: (entry: Extract<LogEntry, { type: "interaction" }>) => Record<string, unknown>,
) {
  const entries: LogEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < 500; i += 1) {
    const result = await runs.poll("moa-1", runId, cursor, 50, new AbortController().signal);
    cursor = result.cursor;
    for (const entry of result.entries) {
      entries.push(entry);
      if (entry.type === "interaction" && answer) {
        await runs.resolve("moa-1", runId, entry.requestId, answer(entry));
      }
      if (entry.type === "done") return { entries, done: entry };
    }
  }
  throw new Error("run never finished");
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never met");
}

const deltasOf = (entries: LogEntry[]) =>
  entries.flatMap((entry) => (entry.type === "deltas" ? (entry.deltas as ThreadDelta[]) : []));

describe("MoaRuns", () => {
  it("consults advisors in parallel, then runs the aggregator with their notes", async () => {
    const { runs, calls, threads, rounds, published } = setup(
      { codex: { answer: "Advice A" }, gemini: { answer: "Advice B" }, "claude-code": { answer: "Fixed it." } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    const { entries, done } = await drain(runs, runs.start("moa-1", START));

    expect(done).toEqual({ type: "done", status: "completed" });
    expect(calls.spawn).toHaveLength(3);
    for (const spawn of calls.spawn) {
      expect(spawn).toMatchObject({
        environment: { type: "reuse", environmentId: "env" },
        visibility: "hidden",
        lifecycleOwnerThreadId: "moa-1",
        permissionMode: "auto",
      });
    }
    const aggregator = [...threads.values()].find((thread) => thread.providerId === "claude-code")!;
    const aggregatorInput = JSON.stringify(aggregator.inputs[0]);
    expect(aggregatorInput).toContain("Fix the bug");
    expect(aggregatorInput).toContain("Advice A");
    expect(aggregatorInput).toContain("Advice B");
    expect(aggregatorInput).toContain("moa_advisor_notes");

    // The advisors show as one live panel embed, backed by the round record.
    const deltas = deltasOf(entries);
    const [round] = [...rounds.rounds.values()];
    expect(round).toMatchObject({
      moaThreadId: "moa-1",
      round: 0,
      question: null,
      finishedAt: expect.any(Number),
      advisors: [
        { label: "CODEX · Model One", status: "answered", answer: "Advice A", workerThreadId: "w1" },
        { label: "GEMINI · Model One", status: "answered", answer: "Advice B", workerThreadId: "w2" },
      ],
    });
    expect(
      deltas.some(
        (delta) =>
          delta.kind === "item.textClose" &&
          delta.text === `::moa-advisors{id="${round!.id}"}`,
      ),
    ).toBe(true);
    expect(deltas.some((delta) => delta.kind === "item.open" && delta.item.type === "delegation")).toBe(false);
    // The next message after the panel is the status line, so a folded
    // finished turn keeps the panel in view.
    const opened = deltas.filter((delta) => delta.kind === "item.open");
    const panelAt = opened.findIndex((delta) => delta.key.providerItemId === `panel-${round!.id}`);
    expect(opened[panelAt + 1]).toMatchObject({
      key: { providerItemId: `handoff-${round!.id}` },
      item: { type: "agentMessage" },
    });
    expect(
      deltas.find(
        (delta) =>
          delta.kind === "item.textClose" && delta.key.providerItemId === `handoff-${round!.id}`,
      ),
    ).toMatchObject({ text: "2 of 2 advisors answered. CLAUDE-CODE · Model One takes it from here." });
    expect(published.filter((id) => id === round!.id).length).toBeGreaterThanOrEqual(3);
    expect(
      deltas.some(
        (delta) => delta.kind === "item.close" && delta.item.type === "agentMessage" && delta.item.text === "Fixed it.",
      ),
    ).toBe(true);
  });

  it("reuses workers on the next turn and tells advisors what the lead answered", async () => {
    const { runs, calls, threads } = setup(
      { codex: { answer: "Advice A" }, gemini: { answer: "Advice B" }, "claude-code": { answer: "Fixed it." } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    await drain(runs, runs.start("moa-1", START));
    await drain(runs, runs.start("moa-1", { ...START, input: [{ type: "text", text: "Now add a test" }] }));

    expect(calls.spawn).toHaveLength(3);
    expect(calls.send).toHaveLength(3);
    const codex = [...threads.values()].find((thread) => thread.providerId === "codex")!;
    const followUp = JSON.stringify(codex.inputs[1]);
    expect(followUp).toContain("Now add a test");
    expect(followUp).toContain("Fixed it.");
  });

  it("forwards the aggregator's approval and resolves it with the answer", async () => {
    const { runs, calls } = setup(
      { "claude-code": { answer: null, approval: true } },
      { version: 1, defaultPresetId: "default", presets: [preset({ advisorsEnabled: false })] },
    );
    const { entries, done } = await drain(runs, runs.start("moa-1", START), () => ({ decision: "allow_once" }));

    expect(entries.some((entry) => entry.type === "interaction" && entry.payload.kind === "approval")).toBe(true);
    expect(calls.resolve).toEqual([
      { threadId: "w1", interactionId: "int-w1", resolution: { decision: "allow_once" } },
    ]);
    expect(done).toEqual({ type: "done", status: "completed" });
  });

  it("goes on without an advisor that runs out of time", async () => {
    const { runs, calls, threads, rounds } = setup(
      { codex: { answer: null }, gemini: { answer: "Advice B" }, "claude-code": { answer: "Fixed it." } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
      150,
    );
    const { done } = await drain(runs, runs.start("moa-1", START));

    expect(done).toMatchObject({ status: "completed" });
    const codex = [...threads.values()].find((thread) => thread.providerId === "codex")!;
    expect(calls.stop).toContain(codex.id);
    const [round] = [...rounds.rounds.values()];
    expect(round!.advisors.map((entry) => [entry.status, entry.error])).toEqual([
      ["timed-out", "No progress for 0s, so it was stopped."],
      ["answered", null],
    ]);
    // Only answers reach the aggregator.
    const aggregator = [...threads.values()].find((thread) => thread.providerId === "claude-code")!;
    const notes = JSON.stringify(aggregator.inputs[0]);
    expect(notes).toContain("Advice B");
    expect(notes).toContain("1 advisor model that");
    expect(notes).not.toContain("CODEX");
  });

  it("stops the workers when the turn is interrupted", async () => {
    const { runs, calls } = setup(
      { "claude-code": { answer: null } },
      { version: 1, defaultPresetId: "default", presets: [preset({ advisorsEnabled: false })] },
    );
    const runId = runs.start("moa-1", START);
    await new Promise((resolve) => setTimeout(resolve, 50));
    runs.interrupt("moa-1", runId);
    const { done } = await drain(runs, runId);

    expect(done).toMatchObject({ status: "interrupted" });
    expect(calls.stop).toContain("w1");
  });

  it("gives a repeated advisor slot its own worker", async () => {
    const slot = { providerId: "codex", model: "m1", reasoningLevel: "medium" as const };
    const store: PresetStore = {
      version: 1,
      defaultPresetId: "default",
      presets: [preset({ advisors: [slot, slot] })],
    };
    const { runs, calls } = setup({ codex: { answer: "Advice" }, "claude-code": { answer: "Done." } }, store);
    await drain(runs, runs.start("moa-1", START));
    await drain(runs, runs.start("moa-1", START));

    expect(calls.spawn.map((spawn) => spawn.providerId)).toEqual(["codex", "codex", "claude-code"]);
    expect(new Set(calls.send.map((send) => send.threadId)).size).toBe(3);
  });

  it("only answers the MoA thread that started the run", async () => {
    const { runs } = setup({ "claude-code": { answer: null } }, {
      version: 1,
      defaultPresetId: "default",
      presets: [preset({ advisorsEnabled: false })],
    });
    const runId = runs.start("moa-1", START);
    const foreign = await runs.poll("other", runId, 0, 0, new AbortController().signal);
    expect(foreign.entries).toEqual([expect.objectContaining({ type: "done", status: "failed" })]);
    runs.interrupt("other", runId);
    const own = await runs.poll("moa-1", runId, 0, 0, new AbortController().signal);
    expect(own.entries.some((entry) => entry.type === "done")).toBe(false);
    runs.interrupt("moa-1", runId);
    await drain(runs, runId);
  });

  it("lets the aggregator consult the advisors mid-turn", async () => {
    const { runs, calls, threads, rounds, record } = setup(
      { codex: { answer: "Advice A" }, gemini: { answer: "Advice B" }, "claude-code": { answer: null, tools: 2 } },
      { version: 1, defaultPresetId: "default", presets: [preset({ fanout: "on-request" })] },
    );
    const runId = runs.start("moa-1", START);
    const aggregator = await waitFor(() =>
      [...threads.values()].find((thread) => thread.providerId === "claude-code" && thread.events.length >= 5),
    );
    expect(calls.spawn.find((spawn) => spawn.providerId === "claude-code")!.pluginMetadata).toMatchObject({
      role: "aggregator",
      consult: true,
    });

    // The provider records the call before it reaches the plugin.
    record(aggregator.id, "item/started", {
      item: { type: "toolCall", id: "consult-1", tool: "moa_consult", server: "bb", arguments: {}, status: "pending" },
    });
    const answer = await runs.consultAdvisors(aggregator.id, "Should I keep the cache?", new AbortController().signal);
    expect(answer).toContain("Advice A");
    expect(answer).toContain("Advice B");
    expect(answer.startsWith("<moa_advisor_notes>")).toBe(true);

    const codex = [...threads.values()].find((thread) => thread.providerId === "codex")!;
    const asked = JSON.stringify(codex.inputs.at(-1));
    expect(asked).toContain("Should I keep the cache?");
    expect(asked).toContain("<work_so_far>");
    expect(asked).toContain("Ran `echo 1` (exit 0)");

    runs.interrupt("moa-1", runId);
    const { entries } = await drain(runs, runId);
    const checkIn = [...rounds.rounds.values()].find((round) => round.round === 1)!;
    expect(checkIn).toMatchObject({
      question: "Should I keep the cache?",
      advisors: [
        { status: "answered", answer: "Advice A" },
        { status: "answered", answer: "Advice B" },
      ],
    });
    const panels = deltasOf(entries).filter(
      (delta) => delta.kind === "item.textClose" && delta.text?.startsWith("::moa-advisors{") === true,
    );
    expect(panels).toHaveLength(2);
    // Mirrored consult row, then the check-in panel, then its status line.
    const opened = deltasOf(entries)
      .filter((delta) => delta.kind === "item.open")
      .map((delta) => delta.key.providerItemId);
    const consultAt = opened.indexOf("agg-consult-1");
    expect(consultAt).toBeGreaterThan(-1);
    expect(opened.slice(consultAt + 1, consultAt + 3)).toEqual([
      `panel-${checkIn.id}`,
      `handoff-${checkIn.id}`,
    ]);
  });

  it("sends a check-in every N tool calls", async () => {
    const { runs, calls, threads } = setup(
      { codex: { answer: "Advice" }, gemini: { answer: "Advice" }, "claude-code": { answer: null, tools: 7 } },
      { version: 1, defaultPresetId: "default", presets: [preset({ fanout: "every-n", fanoutEvery: 2 })] },
    );
    const runId = runs.start("moa-1", START);
    await waitFor(() =>
      [...threads.values()].find((thread) => thread.providerId === "claude-code" && thread.events.length >= 15),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    // After 2 calls; an unanswered check-in holds off the next until 2 + 2×2.
    expect(calls.steer.map((steer) => JSON.stringify(steer.input))).toEqual([
      expect.stringContaining("you have made 2 since"),
      expect.stringContaining("you have made 6 since"),
    ]);
    runs.interrupt("moa-1", runId);
    await drain(runs, runId);
  });

  it("refreshes the aggregator's tools when the preset's fanout changes", async () => {
    const store: PresetStore = { version: 1, defaultPresetId: "default", presets: [preset()] };
    const { runs, calls } = setup({ "claude-code": { answer: "one" } }, store);
    await drain(runs, runs.start("moa-1", START));
    expect(calls.spawn.find((spawn) => spawn.providerId === "claude-code")!.pluginMetadata).toMatchObject({ consult: false });

    store.presets[0] = preset({ fanout: "every-n" });
    await drain(runs, runs.start("moa-1", START));
    expect(calls.metadata).toEqual([
      { threadId: "w3", pluginId: "moa-provider", set: { consult: true } },
    ]);
    expect(calls.stop).toContain("w3");
  });

  it("approves the aggregator's own moa_consult calls without asking the user", async () => {
    const consultApproval = {
      kind: "approval",
      subject: {
        kind: "tool_use",
        tool: "other",
        presentation: { title: "bb-bridge-moa_consult: moa_consult" },
      },
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    };
    const { runs, calls } = setup(
      { "claude-code": { answer: null, approval: true, approvalPayload: consultApproval } },
      { version: 1, defaultPresetId: "default", presets: [preset({ advisorsEnabled: false })] },
    );
    const { entries, done } = await drain(runs, runs.start("moa-1", START));

    expect(entries.some((entry) => entry.type === "interaction")).toBe(false);
    expect(calls.resolve).toEqual([
      {
        threadId: "w1",
        interactionId: "int-w1",
        resolution: { decision: "allow_for_session", grantedPermissions: null },
      },
    ]);
    expect(done).toMatchObject({ status: "completed" });
  });

  it("tells a stray caller there is nobody to consult", async () => {
    const { runs } = setup({}, { version: 1, defaultPresetId: null, presets: [] });
    await expect(runs.consultAdvisors("thr_x", "help?", new AbortController().signal)).resolves.toContain(
      "No Mixture of Agents turn is running",
    );
  });

  it("marks advisors stopped when the turn is interrupted", async () => {
    const { runs, rounds } = setup(
      { codex: { answer: null }, gemini: { answer: "Advice B" } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    const runId = runs.start("moa-1", START);
    await waitFor(() => [...rounds.rounds.values()].find((round) => round.advisors[1]!.status === "answered"));
    runs.interrupt("moa-1", runId);
    const { entries } = await drain(runs, runId);
    const [round] = [...rounds.rounds.values()];
    expect(round!.advisors.map((entry) => entry.status)).toEqual(["stopped", "answered"]);
    expect(
      deltasOf(entries).some(
        (delta) => delta.kind === "item.open" && delta.key.providerItemId?.startsWith("handoff-"),
      ),
    ).toBe(false);
    expect(round!.finishedAt).not.toBeNull();
  });

  it("forgets a deleted thread's rounds", async () => {
    const { runs, rounds } = setup(
      { codex: { answer: "A" }, gemini: { answer: "B" }, "claude-code": { answer: "Done." } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    await drain(runs, runs.start("moa-1", START));
    expect(rounds.rounds.size).toBe(1);
    await runs.forgetThread("moa-1");
    expect(rounds.rounds.size).toBe(0);
  });

  it("starts /moa at once with the panel line, then hands back the answers", async () => {
    const { runs, calls, threads, rounds } = setup(
      { codex: { answer: "Use commander." }, gemini: { answer: "Use yargs." } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    const started = await runs.startAsk({
      threadId: "thr_cc",
      question: "yargs or commander?",
      context: "A small CLI in src/cli.ts.",
      presetId: null,
    });

    // The round exists (so the panel loads) before any advisor has answered.
    const [round] = [...rounds.rounds.values()];
    expect(round).toMatchObject({ moaThreadId: "thr_cc", question: "yargs or commander?", finishedAt: null });
    expect(round!.advisors.every((entry) => entry.status === "running")).toBe(true);
    expect(started).toContain(`::moa-advisors{id="${round!.id}"}`);
    expect(started).toContain(`call moa_answers with round "${round!.id}"`);

    const answer = await runs.askAnswers("thr_cc", round!.id, new AbortController().signal);
    expect(answer).toContain("Use commander.");
    expect(answer).toContain("Use yargs.");
    expect(answer).toContain("The user sees these answers in the advisor panel.");

    expect(calls.spawn).toHaveLength(2);
    for (const spawn of calls.spawn) {
      expect(spawn).toMatchObject({
        environment: { type: "reuse", environmentId: "env" },
        visibility: "hidden",
        lifecycleOwnerThreadId: "thr_cc",
        permissionMode: "accept-edits",
        pluginMetadata: { role: "advisor" },
      });
    }
    const codex = [...threads.values()].find((thread) => thread.providerId === "codex")!;
    const asked = JSON.stringify(codex.inputs[0]);
    expect(asked).toContain("yargs or commander?");
    expect(asked).toContain("A small CLI in src/cli.ts.");
    expect(asked).toContain("Do not modify files");

    // Another thread cannot collect this round.
    await expect(runs.askAnswers("thr_other", round!.id, new AbortController().signal)).rejects.toThrow(
      "not running any more",
    );

    // The same thread's next question reuses its advisors.
    const next = await runs.startAsk({ threadId: "thr_cc", question: "And for tests?", context: null, presetId: null });
    const nextId = /round "([^"]+)"/u.exec(next)![1]!;
    await runs.askAnswers("thr_cc", nextId, new AbortController().signal);
    expect(calls.spawn).toHaveLength(2);
    expect(calls.send).toHaveLength(2);
  });

  it("keeps the advisors working when a client cancels the wait", async () => {
    // Cursor and Codex cancel a tool call after 60 seconds; the agent calls again.
    const { runs, calls, rounds } = setup(
      { codex: { answer: null, stream: { chunks: ["Use ", "yargs."], everyMs: 40, then: "finish" } }, gemini: { answer: "B" } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    const started = await runs.startAsk({ threadId: "thr_cc", question: "q", context: null, presetId: null });
    const id = /round "([^"]+)"/u.exec(started)![1]!;
    const wait = new AbortController();
    const first = runs.askAnswers("thr_cc", id, wait.signal);
    await waitFor(() => (calls.spawn.length === 2 ? true : undefined));
    wait.abort();
    await expect(first).resolves.toContain("still working");
    const answer = await runs.askAnswers("thr_cc", id, new AbortController().signal);
    expect(answer).toContain("Use yargs.");
    expect(calls.stop).toEqual([]);
    expect(rounds.get(id)!.advisors.map((entry) => entry.status)).toEqual(["answered", "answered"]);
  });

  it("stops a /moa round when the turn that asked it ends", async () => {
    const { runs, calls, rounds, statuses } = setup(
      { codex: { answer: null }, gemini: { answer: null } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    const started = await runs.startAsk({ threadId: "thr_cc", question: "q", context: null, presetId: null });
    const id = /round "([^"]+)"/u.exec(started)![1]!;
    await waitFor(() => (calls.spawn.length === 2 ? true : undefined));
    // A late event while the turn still runs changes nothing.
    await runs.onThreadSettled("thr_cc");
    expect(calls.stop).toEqual([]);
    statuses.set("thr_cc", "idle");
    await runs.onThreadSettled("thr_cc");
    await waitFor(() => (calls.stop.length === 2 ? true : undefined));
    expect(calls.stop.sort()).toEqual(["w1", "w2"]);
    await waitFor(() => (rounds.get(id)!.finishedAt !== null ? true : undefined));
    expect(rounds.get(id)!.advisors.map((entry) => entry.status)).toEqual(["stopped", "stopped"]);
  });

  it("carries on when someone else stops an advisor's thread", async () => {
    const { runs, threads, rounds } = setup(
      { codex: { answer: null }, gemini: { answer: "Use yargs." } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    const started = await runs.startAsk({ threadId: "thr_cc", question: "q", context: null, presetId: null });
    const id = /round "([^"]+)"/u.exec(started)![1]!;
    const answers = runs.askAnswers("thr_cc", id, new AbortController().signal);
    const codex = await waitFor(() =>
      [...threads.values()].find(
        (thread) => thread.providerId === "codex" && thread.events.some((row) => row.type === "turn/started"),
      ),
    );
    // Stopped from its own thread view, not by the plugin.
    codex.events.push({
      seq: 1_000_000,
      type: "turn/completed",
      scope: { kind: "turn", turnId: `${codex.id}-t1` },
      data: { status: "interrupted" },
    });
    codex.status = "idle";
    await expect(answers).resolves.toContain("Use yargs.");
    expect(rounds.get(id)!.advisors.map((entry) => [entry.status, entry.error])).toEqual([
      ["stopped", "Its thread was stopped before it finished."],
      ["answered", null],
    ]);
  });

  it("runs one /moa ask at a time per thread", async () => {
    const { runs, calls } = setup(
      { codex: { answer: "A" }, gemini: { answer: "B" } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
    );
    const ask = async (question: string) => {
      const started = await runs.startAsk({ threadId: "thr_cc", question, context: null, presetId: null });
      const id = /round "([^"]+)"/u.exec(started)![1]!;
      return runs.askAnswers("thr_cc", id, new AbortController().signal);
    };
    const results = await Promise.all([ask("one"), ask("two")]);
    expect(results.every((result) => result.includes("A") && result.includes("B"))).toBe(true);
    // The second ask waited, so no worker was stopped mid-answer.
    expect(calls.stop).toEqual([]);
  });

  it("explains a /moa that cannot run", async () => {
    const ask = (runs: MoaRuns, presetId: string | null) =>
      runs.startAsk({ threadId: "thr_cc", question: "q", context: null, presetId });
    const none = setup({}, { version: 1, defaultPresetId: null, presets: [] });
    await expect(ask(none.runs, null)).rejects.toThrow("no Mixture of Agents presets yet");
    const quiet = setup({}, { version: 1, defaultPresetId: "default", presets: [preset({ advisorsEnabled: false })] });
    await expect(ask(quiet.runs, null)).rejects.toThrow("has no advisors switched on");
    await expect(ask(quiet.runs, "nope")).rejects.toThrow('no Mixture of Agents preset "nope". Presets: default.');
  });

  it("does not cut off an advisor that keeps writing past the idle limit", async () => {
    const chunks = ["WAL ", "lets ", "readers ", "and ", "writers ", "overlap."];
    const { runs, rounds, saves } = setup(
      { codex: { answer: null, stream: { chunks, everyMs: 30, then: "finish" } }, gemini: { answer: "B" } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
      100, // idle limit: shorter than the whole answer, longer than each gap
    );
    const started = await runs.startAsk({ threadId: "thr_cc", question: "WAL?", context: null, presetId: null });
    const id = /round "([^"]+)"/u.exec(started)![1]!;
    const answer = await runs.askAnswers("thr_cc", id, new AbortController().signal);

    expect(answer).toContain("WAL lets readers and writers overlap.");
    expect(rounds.get(id)!.advisors[0]).toMatchObject({ status: "answered", activity: null });
    // The panel saw the answer grow while the advisor was still running.
    const partials = saves.map((advisors) => advisors[0]!).filter((entry) => entry.status === "running");
    // Its workspace path shows as relative.
    expect(partials.some((entry) => entry.activity === "Thinking: Weighing the options in src.")).toBe(true);
    expect(partials.some((entry) => entry.answer === "WAL lets ")).toBe(true);
  });

  it("keeps what a stalled advisor wrote and marks it cut off", async () => {
    const { runs, rounds } = setup(
      { codex: { answer: null, stream: { chunks: ["Half an ", "answer"], everyMs: 10, then: "silence" } }, gemini: { answer: "B" } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
      80,
    );
    const started = await runs.startAsk({ threadId: "thr_cc", question: "q", context: null, presetId: null });
    const id = /round "([^"]+)"/u.exec(started)![1]!;
    const answer = await runs.askAnswers("thr_cc", id, new AbortController().signal);

    expect(rounds.get(id)!.advisors[0]).toMatchObject({
      status: "timed-out",
      answer: "Half an answer",
      error: "No progress for 0s, so it was stopped.",
    });
    expect(answer).toContain("Half an answer\n\n[This advisor was cut off before finishing.]");
  });

  it("reports progress when advisors outlast one moa_answers call", async () => {
    const { runs } = setup(
      { codex: { answer: null, stream: { chunks: ["a", "b", "c", "d"], everyMs: 40, then: "finish" } }, gemini: { answer: "B" } },
      { version: 1, defaultPresetId: "default", presets: [preset()] },
      2_000,
      { answersWaitMs: 60 },
    );
    const started = await runs.startAsk({ threadId: "thr_cc", question: "q", context: null, presetId: null });
    const id = /round "([^"]+)"/u.exec(started)![1]!;
    const first = await runs.askAnswers("thr_cc", id, new AbortController().signal);
    expect(first).toContain("The advisors are still working.");
    expect(first).toMatch(/CODEX · Model One: still (writing \(\d+ characters so far\)|thinking|working)/u);
    expect(first).toContain(`Call moa_answers again with round "${id}"`);

    let answer = first;
    for (let i = 0; i < 10 && answer.includes("still working"); i += 1) {
      answer = await runs.askAnswers("thr_cc", id, new AbortController().signal);
    }
    expect(answer).toContain("abcd");
  });

  it("fails clearly when the preset is gone", async () => {
    const { runs } = setup({}, { version: 1, defaultPresetId: null, presets: [] });
    const { done } = await drain(runs, runs.start("moa-1", START));
    expect(done).toMatchObject({ status: "failed", error: expect.stringContaining('"default"') });
  });

  it("retires the old aggregator when the preset's aggregator changes", async () => {
    const store: PresetStore = { version: 1, defaultPresetId: "default", presets: [preset({ advisorsEnabled: false })] };
    const { runs, calls } = setup({ "claude-code": { answer: "one" }, codex: { answer: "two" } }, store);
    await drain(runs, runs.start("moa-1", START));
    store.presets[0] = preset({
      advisorsEnabled: false,
      aggregator: { providerId: "codex", model: "m1", reasoningLevel: "high" },
    });
    await drain(runs, runs.start("moa-1", START));

    expect(calls.archive).toEqual(["w1"]);
    expect(calls.spawn.map((spawn) => spawn.providerId)).toEqual(["claude-code", "codex"]);
    // The new aggregator is told what happened so far.
    expect(JSON.stringify(calls.spawn[1]!.input)).toContain("conversation_so_far");
  });
});
