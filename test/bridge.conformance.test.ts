import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput,
  experimental_formatConformanceReport as formatConformanceReport,
  experimental_runBridgeConformance as runBridgeConformance,
  type CapturedBridgeJsonRpcOutput,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "../src/bridge.js";
import { createFakeServer, createTransport } from "./fake-server.js";

let output: CapturedBridgeJsonRpcOutput;
let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-moa-conformance-"));
  output = captureBridgeJsonRpcOutput();
});

afterEach(() => {
  output.restore();
  rmSync(workspaceDir, { recursive: true, force: true });
});

it("passes the canonical protocol suite", async () => {
  const server = createFakeServer((start) => {
    const text = JSON.stringify(start.input);
    if (text.includes("/noop")) return [{ type: "done", status: "completed" }];
    if (text.includes("wait forever")) return "hang";
    return [
      {
        type: "deltas",
        deltas: [
          {
            kind: "item.open",
            key: { providerItemId: "agg-m1" },
            item: { type: "agentMessage", text: "" },
          },
          {
            kind: "item.textDelta",
            key: { providerItemId: "agg-m1" },
            channel: "agentMessage",
            text: "hello",
          },
          {
            kind: "item.close",
            key: { providerItemId: "agg-m1" },
            status: "completed",
            item: { type: "agentMessage", text: "hello" },
          },
        ],
      },
      { type: "done", status: "completed" },
    ];
  });

  const report = await runBridgeConformance({
    transport: createTransport({
      handleLine,
      takeMessages: output.takeMessages,
      server,
    }),
    providerId: "moa",
    session: {
      cwd: workspaceDir,
      promptInput: [{ type: "text", text: "say hello", mentions: [] }],
      zeroWorkPromptInput: [{ type: "text", text: "/noop", mentions: [] }],
      interruptiblePromptInput: [{ type: "text", text: "wait forever", mentions: [] }],
      options: {
        model: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        providerOptions: { presetId: "default", permissionMode: "full", models: [] },
      },
    },
    timeoutMs: 5_000,
  });

  output.restore();
  console.info(`moa bridge conformance:\n${formatConformanceReport(report)}`);
  const failed = report.results.filter((result) => result.status === "fail");
  expect(failed).toEqual([]);
  expect(report.passed).toBe(true);
  expect(server.calls.some((call) => call.op === "start")).toBe(true);
}, 60_000);
