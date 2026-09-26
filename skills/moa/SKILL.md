---
name: moa
description: Ask the Mixture of Agents advisors (the user's other models) a question from this thread. Use when the user types /moa <question> (or $moa), or asks what the Mixture of Agents or the advisors think.
---

# /moa: ask the Mixture of Agents

The user wants a second opinion from their Mixture of Agents advisors: other
models (for example Codex or Pi) that can read this workspace and answer in
parallel. You play the aggregator: you weigh what they say.

1. Call the `moa_ask` tool.
   - `question`: the user's question, the text after `/moa`. If there is
     none, ask about what the user is working on now.
   - `context`: what the advisors need, since they cannot see this
     conversation: the goal, relevant files and findings, what has been tried.
   - `preset`: only when the user names a preset (`bb moa list` shows the
     ids). Otherwise the default preset answers.
2. It returns at once with a `::moa-advisors{id="…"}` line. Write that line
   in your reply straight away, on its own line: BB shows it as a live
   panel, so the user watches each advisor answer.
3. Call `moa_answers` with the round `moa_ask` gave you. It waits about
   three minutes at a time. If it reports they are still working, call it
   again with the same round (strong models can take several minutes); do
   not answer the user in the meantime. Then it returns their answers.
4. Then answer the user yourself: where the advisors agree or disagree, what
   you would do, and why. Start that answer with the same `::moa-advisors`
   line, on its own line: when the turn finishes, BB folds its steps (and the
   first panel with them) and keeps only your answer in view.

If `moa_ask` or `moa_answers` is not available in this session, say so: tools are fixed when a
session starts, so a new thread (or reloading this one) picks it up, and the
Mixture of Agents plugin must be enabled.
