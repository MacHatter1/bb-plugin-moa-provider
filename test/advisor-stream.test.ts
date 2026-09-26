import { describe, expect, it } from "vitest";
import { AdvisorStream, pathShortener } from "../src/advisor-stream.js";

const event = (type: string, data: Record<string, unknown>) => ({ type, data });

describe("AdvisorStream", () => {
  it("follows thinking, tool activity, and the answer as it is written", () => {
    const stream = new AdvisorStream();
    stream.apply([
      event("item/started", { item: { type: "reasoning", id: "r1" } }),
      event("item/reasoning/textDelta", { itemId: "r1", delta: "First, check the\nschema." }),
    ]);
    expect(stream.activity).toBe("Thinking: First, check the schema.");
    stream.apply([event("item/started", { item: { type: "fileRead", id: "f1", path: "src/db.ts" } })]);
    expect(stream.activity).toBe("Reading src/db.ts");

    stream.apply([
      event("item/started", { item: { type: "agentMessage", id: "m1", text: "" } }),
      event("item/agentMessage/delta", { itemId: "m1", delta: "Use " }),
      event("item/agentMessage/delta", { itemId: "m1", delta: "WAL." }),
    ]);
    expect(stream.text).toBe("Use WAL.");
    expect(stream.activity).toBe("Writing");

    // A later message replaces the earlier one; the latest is the answer.
    stream.apply([
      event("item/started", { item: { type: "agentMessage", id: "m2", text: "" } }),
      event("item/agentMessage/delta", { itemId: "m2", delta: "Final" }),
      event("item/completed", { item: { type: "agentMessage", id: "m2", text: "Final answer." } }),
    ]);
    expect(stream.text).toBe("Final answer.");
  });

  it("ignores sub-agent items and deltas for other messages", () => {
    const stream = new AdvisorStream();
    const changed = stream.apply([
      event("item/started", { item: { type: "agentMessage", id: "n1", text: "nested", parentToolCallId: "t" } }),
      event("item/agentMessage/delta", { itemId: "n1", delta: "nested" }),
    ]);
    expect(changed).toBe(false);
    expect(stream.text).toBeNull();
  });

  it("previews only the tail of long reasoning", () => {
    const stream = new AdvisorStream();
    stream.apply([
      event("item/started", { item: { type: "reasoning", id: "r" } }),
      event("item/reasoning/textDelta", { itemId: "r", delta: `${"x".repeat(500)} the end` }),
    ]);
    expect(stream.activity!.length).toBeLessThanOrEqual(140);
    expect(stream.activity).toMatch(/^Thinking: …x+ the end$/u);
  });

  it("shows workspace paths as relative and the home directory as ~", () => {
    const stream = new AdvisorStream({
      workspace: "/Users/sam/.bb/worktrees/thr_1/pantry/",
      home: "/Users/sam",
    });
    stream.apply([
      event("item/started", {
        item: { type: "fileRead", id: "f", path: "/Users/sam/.bb/worktrees/thr_1/pantry/src/pantry.js" },
      }),
    ]);
    expect(stream.activity).toBe("Reading src/pantry.js");
    stream.apply([
      event("item/started", {
        item: {
          type: "commandExecution",
          id: "c",
          command: "cd /Users/sam/.bb/worktrees/thr_1/pantry && node --test",
        },
      }),
    ]);
    expect(stream.activity).toBe("Running node --test");
    stream.apply([
      event("item/started", { item: { type: "reasoning", id: "r" } }),
      event("item/reasoning/textDelta", { itemId: "r", delta: "Check /Users/sam/.npmrc too." }),
    ]);
    expect(stream.activity).toBe("Thinking: Check ~/.npmrc too.");
  });
});

describe("pathShortener", () => {
  const shorten = pathShortener({ workspace: "/work/app", home: "/home/sam" });

  it("leaves paths that only share a prefix alone", () => {
    expect(shorten("ls /work/app-old /home/samuel")).toBe("ls /work/app-old /home/samuel");
  });

  it("turns the bare roots into . and ~", () => {
    expect(shorten("cd /work/app; ls /home/sam")).toBe("cd .; ls ~");
  });

  it("changes nothing without roots, or with a root of /", () => {
    expect(pathShortener({})("/work/app/x")).toBe("/work/app/x");
    expect(pathShortener({ workspace: "/" })("/work/app/x")).toBe("/work/app/x");
  });
});
