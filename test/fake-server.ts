// A stand-in for the plugin server on the other end of `moa_turn`: the tests
// drive the real bridge and answer its tool calls from a scripted run log.
import type { BridgeConformanceTransport } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  MOA_TOOL_NAME,
  toolArgsSchema,
  type LogEntry,
  type ToolArgs,
} from "../src/wire.js";

export type Script = (start: Extract<ToolArgs, { op: "start" }>) => LogEntry[] | "hang";

interface FakeRun {
  log: LogEntry[];
  hang: boolean;
  interrupted: boolean;
}

export interface FakeServer {
  calls: ToolArgs[];
  runs: Map<string, FakeRun>;
  answer(args: ToolArgs): unknown;
}

export function createFakeServer(script: Script): FakeServer {
  const calls: ToolArgs[] = [];
  const runs = new Map<string, FakeRun>();
  return {
    calls,
    runs,
    answer(args) {
      calls.push(args);
      switch (args.op) {
        case "start": {
          const runId = `run-${runs.size + 1}`;
          const log = script(args);
          runs.set(runId, {
            log: log === "hang" ? [] : log,
            hang: log === "hang",
            interrupted: false,
          });
          return { runId };
        }
        case "poll": {
          const run = runs.get(args.runId);
          if (run === undefined) {
            return { cursor: args.cursor, entries: [{ type: "done", status: "failed", error: "gone" }] };
          }
          return { cursor: run.log.length, entries: run.log.slice(args.cursor) };
        }
        case "resolve":
          return { ok: true };
        case "interrupt": {
          const run = runs.get(args.runId);
          if (run !== undefined) run.interrupted = true;
          return { ok: true };
        }
      }
    },
  };
}

interface Message {
  id?: string | number;
  method?: string;
  params?: { tool?: string; arguments?: unknown };
}

/**
 * Wraps the bridge so `moa_turn` calls never reach the test runtime: each one
 * is answered from the fake server a moment later, like the real round trip.
 */
export function createTransport(args: {
  handleLine: (line: string) => void;
  takeMessages: () => unknown[];
  server: FakeServer;
  delayMs?: number;
}): BridgeConformanceTransport & { settle(): Promise<void> } {
  let inFlight = 0;
  const answer = (message: Message) => {
    inFlight += 1;
    setTimeout(() => {
      inFlight -= 1;
      const parsed = toolArgsSchema.parse(message.params?.arguments);
      const result = args.server.answer(parsed);
      args.handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            success: true,
            contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
          },
        }),
      );
    }, args.delayMs ?? 5);
  };
  return {
    send: args.handleLine,
    takeMessages() {
      return args.takeMessages().filter((raw) => {
        const message = raw as Message;
        if (message.method === "item/tool/call" && message.params?.tool === MOA_TOOL_NAME) {
          answer(message);
          return false;
        }
        return true;
      });
    },
    async settle() {
      for (let i = 0; i < 400 && inFlight > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}
