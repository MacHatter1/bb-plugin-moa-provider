// End to end through the real bridge and BB's own delta assembler: advisor
// rows plus a recorded Claude Code turn, mirrored the way src/runs.ts does it.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
  type BridgeJsonRpcTestHarness,
  type ThreadEvent,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import { handleLine } from "../src/bridge.js";
import { AggregatorMirror, type MirrorEvent } from "../src/mirror.js";
import type { LogEntry } from "../src/wire.js";
import { createFakeServer, createTransport, type Script } from "./fake-server.js";

const THREAD_ID = "thr_moa_stream";
const OPTIONS = {
  model: "default",
  reasoningLevel: "medium",
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
  providerOptions: { presetId: "default", permissionMode: "full", models: [] },
};
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/aggregator-turn.json", import.meta.url), "utf8"),
) as MirrorEvent[];

const PANEL = '::moa-advisors{id="00000000-0000-4000-8000-000000000000:0"}';

/** What src/runs.ts emits when an advisor round starts. */
function advisorDeltas(): ThreadDelta[] {
  const key = { providerItemId: "panel-r1:0" };
  return [
    { kind: "item.open", key, item: { type: "agentMessage", text: "" } },
    { kind: "item.textDelta", key, channel: "agentMessage", text: PANEL },
    { kind: "item.textClose", key, channel: "agentMessage", text: PANEL },
  ];
}

function mirrored(events: readonly MirrorEvent[]): LogEntry[] {
  const mirror = new AggregatorMirror();
  return events
    .filter((event) => event.type !== "turn/completed")
    .map((event) => ({ type: "deltas" as const, deltas: mirror.translate(event) }))
    .filter((entry) => entry.deltas.length > 0);
}

let harness: BridgeJsonRpcTestHarness;
/** Reads the bridge's pending output; set by each runTurn. */
let pump: () => Promise<void> = async () => undefined;
let stderr: string[];
const originalStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  harness = createBridgeJsonRpcTestHarness(handleLine);
  stderr = [];
  process.stderr.write = ((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  harness.restore();
});

async function runTurn(
  script: Script,
  answerInteraction?: (payload: unknown) => unknown,
  server = createFakeServer(script),
): Promise<ThreadEvent[]> {
  const transport = createTransport({ handleLine, takeMessages: harness.takeMessages, server });
  const collector = createBridgeDeltaEventCollector("moa");
  const events: ThreadEvent[] = [];
  const collect = () => {
    for (const message of transport.takeMessages()) {
      const { id, method, params } = message as { id?: string; method?: string; params?: { payload?: unknown } };
      if (method === "interaction/request" && answerInteraction) {
        const result = answerInteraction(params?.payload);
        setTimeout(() => handleLine(JSON.stringify({ jsonrpc: "2.0", id, result })), 1);
        continue;
      }
      events.push(...collector.assembleMessage(message as { method?: string; params?: unknown }));
    }
  };
  pump = async () => {
    await harness.flushWork();
    collect();
    await transport.settle();
  };
  harness.sendRequest(1, "initialize", {
    protocolVersion: 2,
    client: { name: "moa-stream-test", version: "0.0.0" },
    grammarVersions: [3, 3],
  } as never);
  harness.sendRequest(2, "thread/start", {
    threadId: THREAD_ID,
    cwd: "/w",
    options: OPTIONS,
    instructionMode: "append",
  } as never);
  await harness.flushWork();
  collect();
  harness.sendRequest(3, "turn/start", {
    threadId: THREAD_ID,
    providerThreadId: `moa-${THREAD_ID}`,
    clientRequestId: "creq_mxa2345678",
    input: [{ type: "text", text: "change a.ts", mentions: [] }],
    options: OPTIONS,
  } as never);
  // Poll until the turn's own boundary lands (the advisor's child turn
  // completes first, under the delegation).
  const topLevelDone = () =>
    events.some(
      (event) =>
        event.type === "turn/completed" &&
        (event as { parentToolCallId?: string }).parentToolCallId === undefined,
    );
  for (let i = 0; i < 400 && !topLevelDone(); i += 1) {
    await harness.flushWork();
    collect();
    await transport.settle();
  }
  collect();
  return events;
}

type ItemEvent = Extract<ThreadEvent, { type: "item/started" | "item/completed" }>;
const items = (events: ThreadEvent[], type: "item/started" | "item/completed") =>
  events.filter((event): event is ItemEvent => event.type === type).map((event) => event.item);

describe("MoA turn stream", () => {
  it("embeds the advisor panel and mirrors the aggregator turn", async () => {
    const events = await runTurn(() => [
      { type: "deltas", deltas: advisorDeltas() },
      ...mirrored(fixture),
      { type: "done", status: "completed" },
    ]);

    expect(stderr.join("")).not.toContain("invalid delta");
    const completed = items(events, "item/completed");
    const started = items(events, "item/started");

    const messages = completed.filter((item) => item.type === "agentMessage");
    expect(messages[0]).toMatchObject({ text: PANEL });

    const answer = messages.at(-1);
    expect(answer).toMatchObject({ text: "Done: changed a.ts." });

    const change = completed.find((item) => item.type === "fileChange");
    expect(change).toMatchObject({ changes: [{ path: "/w/a.ts", kind: "update" }] });
    expect(JSON.stringify(change)).toContain("+b");

    const sourceCommands = fixture.filter(
      (event) =>
        event.type === "item/started" &&
        (event.data as { item: { type: string } }).item.type === "commandExecution" &&
        (event.data as { item: { parentToolCallId?: string } }).item.parentToolCallId === undefined,
    ).length;
    expect(started.filter((item) => item.type === "commandExecution")).toHaveLength(sourceCommands);
    expect(completed.filter((item) => item.type === "reasoning").length).toBeGreaterThan(0);
    expect(completed.filter((item) => item.type === "toolCall").length).toBeGreaterThan(0);

    // The aggregator's own prompt (with the advisor notes) and nested
    // sub-agent items never reach the MoA thread.
    expect(started.some((item) => item.type === "userMessage")).toBe(false);
    expect(JSON.stringify(started)).not.toContain('"command":"ls"');

    // Every item the turn opened is settled by its end.
    const settled = new Set(completed.map((item) => item.id));
    expect(started.filter((item) => !settled.has(item.id))).toEqual([]);
    const turnEnd = events.filter((event) => event.type === "turn/completed").at(-1);
    expect(turnEnd).toMatchObject({ status: "completed" });
  });

  it("fails the turn with the server's message", async () => {
    const events = await runTurn(() => [
      { type: "done", status: "failed", error: 'There is no Mixture of Agents preset named "x".' },
    ]);
    const turnEnd = events.filter((event) => event.type === "turn/completed").at(-1);
    expect(turnEnd).toMatchObject({ status: "failed", error: { message: expect.stringContaining("preset") } });
  });

  it("raises the aggregator's approval and relays the bare decision back", async () => {
    const payload = {
      kind: "approval",
      subject: { kind: "command", itemId: "i1", command: "pwd", cwd: null, actions: [], sessionGrant: null },
      reason: "Not in allowlist: pwd",
      availableDecisions: ["allow_once", "allow_for_session", "deny"],
    };
    const script: Script = () => [
      { type: "interaction", requestId: "run-1:pint_1", payload },
      { type: "done", status: "completed" },
    ];
    const server = createFakeServer(script);
    const seen: unknown[] = [];
    await runTurn(
      script,
      (asked) => {
        seen.push(asked);
        return { decision: "allow_for_session", grantedPermissions: null };
      },
      server,
    );
    for (let i = 0; i < 50 && !server.calls.some((call) => call.op === "resolve"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pump();
    }
    expect(seen).toEqual([payload]);
    expect(server.calls.find((call) => call.op === "resolve")).toEqual({
      op: "resolve",
      runId: "run-1",
      requestId: "run-1:pint_1",
      resolution: { decision: "allow_for_session", grantedPermissions: null },
    });
    expect(stderr.join("")).not.toContain("interaction");
  });
});
