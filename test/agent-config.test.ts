import { describe, expect, it } from "vitest";
import { agentConfiguration } from "../src/agent-config.js";
import { resolutionOf } from "../src/bridge.js";
import { presetSchema } from "../src/presets.js";
import { consultApprovalDecision } from "../src/runs.js";

describe("agentConfiguration", () => {
  it("gives MoA threads the bridge channel and ordinary threads /moa", () => {
    expect(agentConfiguration({ provider: { id: "moa" }, pluginMetadata: {} })).toEqual({
      tools: ["moa_turn"],
      skills: ["moa", "moa-threads"],
    });
    expect(agentConfiguration({ provider: { id: "codex" }, pluginMetadata: {} })).toEqual({
      tools: ["moa_ask", "moa_answers"],
      skills: ["moa", "moa-threads"],
    });
  });

  it("keeps workers to their job: moa_consult only for consulting aggregators", () => {
    const config = (metadata: Record<string, unknown>) =>
      agentConfiguration({ provider: { id: "claude-code" }, pluginMetadata: metadata });
    expect(config({ role: "aggregator", consult: true })).toEqual({ tools: ["moa_consult"], skills: [] });
    expect(config({ role: "aggregator", consult: false })).toEqual({ tools: [], skills: [] });
    expect(config({ role: "advisor", consult: true })).toEqual({ tools: [], skills: [] });
  });
});

describe("preset fanout", () => {
  it("defaults presets saved before fanout existed to once per message", () => {
    const parsed = presetSchema.parse({
      id: "old",
      name: "Old",
      description: "",
      aggregator: { providerId: "codex", model: "m", reasoningLevel: "high" },
      advisors: [],
      advisorsEnabled: true,
    });
    expect(parsed).toMatchObject({ fanout: "message", fanoutEvery: 5 });
  });
});

describe("interaction helpers", () => {
  it("reads the runtime's answer to interaction/request", () => {
    expect(resolutionOf({ decision: "deny" })).toEqual({ decision: "deny" });
    expect(resolutionOf({ kind: "user_answer", answers: {} })).toEqual({ kind: "user_answer", answers: {} });
    expect(resolutionOf({ payload: {}, resolution: { decision: "allow_once" } })).toEqual({ decision: "allow_once" });
    expect(resolutionOf(null)).toBeNull();
    expect(resolutionOf({ unrelated: true })).toBeNull();
  });

  it("recognises approvals for moa_consult and nothing else", () => {
    const approval = (subject: Record<string, unknown>, availableDecisions = ["allow_once", "deny"]) => ({
      kind: "approval",
      subject,
      availableDecisions,
    });
    expect(consultApprovalDecision(approval({ kind: "tool_use", tool: "mcp__bb-bridge__moa_consult" }))).toBe("allow_once");
    expect(
      consultApprovalDecision(
        approval({ kind: "tool_use", tool: "other", presentation: { title: "bb-bridge-moa_consult: moa_consult" } }, [
          "allow_once",
          "allow_for_session",
        ]),
      ),
    ).toBe("allow_for_session");
    expect(consultApprovalDecision(approval({ kind: "tool_use", tool: "moa_consultant" }))).toBeNull();
    expect(consultApprovalDecision(approval({ kind: "command", command: "moa_consult" }))).toBeNull();
    expect(consultApprovalDecision({ kind: "user_question" })).toBeNull();
  });
});
