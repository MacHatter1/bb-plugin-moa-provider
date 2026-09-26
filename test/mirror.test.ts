import { describe, expect, it } from "vitest";
import { AggregatorMirror, isToolCompletion } from "../src/mirror.js";

const completed = (item: Record<string, unknown>) => ({
  type: "item/completed",
  data: { item: { status: "completed", ...item } },
});

describe("AggregatorMirror", () => {
  it("shows moa_consult calls but does not count or summarise them", () => {
    const mirror = new AggregatorMirror();
    for (const tool of ["moa_consult", "mcp__bb-bridge__moa_consult"]) {
      const event = completed({ type: "toolCall", id: tool, tool, server: "bb", arguments: {} });
      const event2 = completed({ type: "toolCall", id: `${tool}-2`, tool, server: "bb", arguments: {}, result: "<moa_advisor_notes>…" });
      const [close] = mirror.translate(event2);
      expect(close).toMatchObject({
        kind: "item.close",
        item: { type: "tool", tool },
        presentation: { label: { completed: "Consulted advisors" } },
      });
      expect(JSON.stringify(close)).not.toContain("moa_advisor_notes");
      expect(mirror.translate(event)).toHaveLength(1);
      expect(isToolCompletion(event)).toBe(false);
    }
    expect(mirror.progressDigest()).toBe("");
    expect(isToolCompletion(completed({ type: "commandExecution", id: "c", command: "ls", cwd: "/" }))).toBe(true);
    expect(isToolCompletion(completed({ type: "agentMessage", id: "m", text: "hi" }))).toBe(false);
    expect(
      isToolCompletion(completed({ type: "commandExecution", id: "n", command: "ls", cwd: "/", parentToolCallId: "a" })),
    ).toBe(false);
  });

  it("summarises the turn's work for advisors, newest steps first to survive", () => {
    const mirror = new AggregatorMirror();
    mirror.translate(completed({ type: "commandExecution", id: "c1", command: "npm test", cwd: "/", exitCode: 1, aggregatedOutput: "1 failing\n" }));
    mirror.translate(completed({ type: "fileChange", id: "f1", changes: [{ path: "/w/a.ts", kind: "update", diff: "-a\n+b" }] }));
    mirror.translate(completed({ type: "agentMessage", id: "m1", text: "Fixed the test." }));
    expect(mirror.progressDigest()).toBe(
      "- Ran `npm test` (exit 1)\n  1 failing\n- update /w/a.ts\n-a\n+b\n- Said: Fixed the test.",
    );

    const long = new AggregatorMirror();
    for (let index = 0; index < 50; index += 1) {
      long.translate(completed({ type: "fileRead", id: `r${index}`, path: `/w/file-${index}.ts` }));
    }
    const digest = long.progressDigest(200);
    expect(digest).toMatch(/^- \(\d+ earlier steps omitted\)/u);
    expect(digest).toContain("/w/file-49.ts");
    expect(digest).not.toContain("/w/file-0.ts");
  });
});
