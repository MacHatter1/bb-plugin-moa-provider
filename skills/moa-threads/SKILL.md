---
name: moa-threads
description: Run or inspect Mixture of Agents (MoA) threads in BB — the "moa" provider whose models are presets that pair advisor agents with an aggregator agent. Use when asked to use Mixture of Agents or MoA, to spawn a thread on several models at once, to list MoA presets, or to explain what a MoA thread's hidden worker threads are. To ask the advisors a question from an ordinary thread, use the moa skill (/moa) instead.
---

# Mixture of Agents

The `moa` provider runs each user message through a preset:

1. **Advisors** (zero to six provider/model slots) get the request, in parallel,
   and answer once. They may read the workspace but are told not to change it,
   and any approval they ask for is declined.
2. The **aggregator** (one slot) gets the user's message plus the advisors'
   answers as private notes, then does the real work: tools, edits, and the
   reply.

Every slot is an ordinary BB provider (Claude Code, Codex, Pi, ACP agents,
plugin providers) running as a **hidden worker thread** in the MoA thread's
environment. Workers belong to the MoA thread: they archive and delete with
it, and they are reused on later messages, so each keeps its own context.

## Commands

- `bb moa list` — presets with their slots; `--json` for the stored shape.
- `bb thread spawn --provider moa --model <preset-id> --prompt "…"` — start a
  MoA thread. `bb provider models moa` lists the preset ids.
- `bb thread list --include-hidden` — the workers. Their titles start with
  `MoA advisor ·` or `MoA aggregator ·`.

Presets are edited in Settings → Plugins → Mixture of Agents. There is no CLI
to write them.

## Behaviour to know

- The MoA thread shows each advisor round as a live panel, written as a
  `::moa-advisors{id="…"}` line in the thread (it renders as a card in the
  app; in `bb thread log` output it stays that literal line). It then
  mirrors the aggregator's commands, file changes, reasoning, and reply.
  The advisors' answers are in the panel, or in their worker threads.
- The aggregator's approvals and questions are raised in the MoA thread.
- Stopping the MoA thread stops every worker still running.
- A preset can also consult mid-task ("Consult them again mid-task"): the
  aggregator gets a `moa_consult` tool, and with "every N tool calls" it is
  sent a "Mixture of Agents check-in" message asking it to call that tool.
  If you are the aggregator and see such a check-in, it is genuine: call
  `moa_consult` with your progress and plan, then continue.
- An advisor that fails or passes the time limit (setting
  `advisorTimeoutSeconds`, default 300) is dropped for that message; the
  aggregator still runs.
- Background work the aggregator starts, and anything it does after its turn
  ends, stays in the hidden worker thread. Open the worker to see it.
- A message costs one advisor turn per advisor plus the aggregator's whole
  turn. Most of the cost is the aggregator's.
