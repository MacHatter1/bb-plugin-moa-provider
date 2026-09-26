import { describe, expect, it } from "vitest";
import {
  advisorAskPrompt,
  advisorConsultPrompt,
  advisorFirstPrompt,
  advisorFollowUpPrompt,
  advisorNotesBlock,
  aggregatorPreamble,
  askAnswersText,
  askStartedText,
  CONSULT_TOOL_INSTRUCTIONS,
  consultNudge,
  consultResultText,
  promptText,
  roundHandoffText,
} from "../src/prompts.js";

describe("prompts", () => {
  it("reads the text of a prompt and marks attachments", () => {
    expect(
      promptText([
        { type: "text", text: "Look at this", mentions: [] },
        { type: "localImage", path: "/a.png" },
        { type: "localFile", path: "/b.pdf", name: "spec.pdf" },
      ]),
    ).toBe("Look at this\n[image attached]\n[file attached: spec.pdf]");
  });

  it("gives a fresh advisor the rules and the earlier conversation", () => {
    const prompt = advisorFirstPrompt([{ user: "Hi", answer: "Hello" }], "Fix it");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("Keep to this workspace");
    expect(prompt).toContain("<conversation_so_far>");
    expect(prompt).toContain("<user_request>\nFix it\n</user_request>");
  });

  it("pairs the lead's last answer with the request it answered", () => {
    const prompt = advisorFollowUpPrompt({ user: "Make a.txt", answer: "Made it." }, "Now b.txt");
    expect(prompt).toMatch(
      /<last_finished_turn>\n<user_request>\nMake a.txt\n<\/user_request>\n<lead_agent_answer>\nMade it.\n/u,
    );
    expect(prompt).toContain("<new_user_request>\nNow b.txt\n</new_user_request>");
  });

  it("keeps only answered advisors and separates the block from the user's text", () => {
    const block = advisorNotesBlock([
      { label: 'Codex · "GPT"', text: "Use a map.", error: null },
      { label: "Pi", text: null, error: "timed out" },
    ]);
    expect(block.startsWith("\n\n<moa_advisor_notes>")).toBe(true);
    expect(block).toContain("Private notes from 1 advisor model that");
    expect(block).toContain(`<advisor index="1" model="Codex · 'GPT'">\nUse a map.\n</advisor>`);
    expect(block).not.toContain("Pi");
    expect(advisorNotesBlock([{ label: "Pi", text: "  ", error: null }])).toBe("");
  });

  it("briefs a replacement aggregator only when there is history", () => {
    expect(aggregatorPreamble([])).toBe("");
    expect(aggregatorPreamble([{ user: "a", answer: "b" }])).toMatch(/follows\.\n\n$/u);
  });

  it("asks advisors mid-turn with the lead's question and its work so far", () => {
    const prompt = advisorConsultPrompt("Keep the cache?", "- Ran `npm test` (exit 0)");
    expect(prompt).toContain("<work_so_far>\n- Ran `npm test` (exit 0)\n</work_so_far>");
    expect(prompt).toContain("<lead_agent_question>\nKeep the cache?\n</lead_agent_question>");
    expect(advisorConsultPrompt("Q", "")).not.toContain("work_so_far");
  });

  it("returns the notes to the aggregator, or says nobody answered", () => {
    expect(consultResultText([{ label: "Pi", text: "Yes.", error: null }])).toMatch(/^<moa_advisor_notes>/u);
    expect(consultResultText([{ label: "Pi", text: null, error: "timed out" }])).toBe(
      "No advisor answered in time. Carry on with your own judgement.",
    );
    expect(consultNudge(3)).toMatch(/^Mixture of Agents check-in: .* you have made 3 since/u);
    expect(consultNudge(3)).toContain("call `moa_consult` now");
    // Nothing secretive: that reads like a prompt injection to the model.
    expect(consultNudge(3)).not.toMatch(/do not (mention|tell)/iu);
    expect(CONSULT_TOOL_INSTRUCTIONS).toContain('titled "Mixture of Agents check-in"');
  });

  it("words the status line after each advisor panel", () => {
    const base = { total: 2, aggregator: "Claude Code · Sonnet 5" };
    expect(roundHandoffText({ ...base, round: 0, answered: 2 })).toBe(
      "2 of 2 advisors answered. Claude Code · Sonnet 5 takes it from here.",
    );
    expect(roundHandoffText({ ...base, round: 1, answered: 1 })).toBe(
      "1 of 2 advisors answered the check-in. Claude Code · Sonnet 5 continues.",
    );
    expect(roundHandoffText({ ...base, round: 0, answered: 0 })).toBe(
      "No advisor answered. Claude Code · Sonnet 5 carries on alone.",
    );
    expect(roundHandoffText({ round: 0, answered: 1, total: 1, aggregator: "Pi" })).toBe(
      "1 of 1 advisor answered. Pi takes it from here.",
    );
  });

  it("asks advisors for /moa with the lead's context", () => {
    const fresh = advisorAskPrompt(true, "Which queue?", "We use Postgres.");
    expect(fresh).toContain("Do not modify files");
    expect(fresh).toContain("<context_from_lead_agent>\nWe use Postgres.\n</context_from_lead_agent>");
    expect(fresh).toContain("<question>\nWhich queue?\n</question>");
    const followUp = advisorAskPrompt(false, "Which queue?", null);
    expect(followUp).not.toContain("Do not modify files");
    expect(followUp).not.toContain("context_from_lead_agent");
  });

  it("hands the asking agent the panel line first, then the answers", () => {
    const started = askStartedText('::moa-advisors{id="x:0"}', "x:0");
    expect(started).toContain('write this line in your reply, on its own. BB shows it as a live panel of their answers:\n::moa-advisors{id="x:0"}');
    expect(started).toContain('call moa_answers with round "x:0"');

    const answers = askAnswersText([{ label: "Pi", text: "Use SQS.", error: null }], '::moa-advisors{id="x:0"}');
    expect(answers).toContain("The user sees these answers in the advisor panel.");
    expect(answers).not.toContain("The user cannot see them");
    expect(answers).toContain('Start your answer with the panel line again, on its own line, so the panel stays in view above it once the turn\'s steps fold away: ::moa-advisors{id="x:0"}');
    expect(askAnswersText([], "::p")).toMatch(/^No advisor answered in time\./u);
  });
});
