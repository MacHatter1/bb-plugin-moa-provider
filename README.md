# bb-plugin-moa

Mixture of Agents for [BB](https://github.com/get-bb/bb), modelled on
[Hermes Agent's MoA](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents).
It adds a **Mixture of Agents** provider to the model picker. Its models are
presets: each preset has advisor slots that answer first and an aggregator
slot that reads their answers and does the work. Any installed BB provider
and model can fill a slot.

## How a turn runs

```
you ──▶ MoA thread ──▶ advisors (parallel, read-only) ──▶ notes
                          │                                  │
                          └──────────▶ aggregator ◀──────────┘
                                          │  tools, edits, reply
                   MoA timeline ◀─────────┘  (mirrored live)
```

1. Each advisor gets your message (and, on its first turn, the conversation
   so far). They run in parallel and are told not to change anything. Any
   approval an advisor asks for is declined, so a hidden advisor never waits
   on you.
2. The aggregator gets your message unchanged, followed by the advisors'
   answers as a private `<moa_advisor_notes>` block. Appending the notes keeps
   its cached conversation prefix intact, as in Hermes.
3. The MoA thread shows the round as an **advisor panel** (below), then
   mirrors the aggregator's reasoning, commands, file changes, and reply as
   they happen. The aggregator's approvals and questions appear in the MoA
   thread, and your answers go back to it.

### The advisor panel

Every advisor round appears in the MoA thread as a live card, embedded with
the `::moa-advisors{id="…"}` message directive:

- One row per advisor: provider icon, model, reasoning level, status with a
  running timer, what it is doing right now (a preview of its reasoning, the
  command or file it is on), and its answer as Markdown, streamed as it
  writes (long answers fold; **Show all** expands them).
- **Open ↗** jumps to that advisor's hidden worker thread.
- The header counts answers and time for the round. Mid-task rounds are
  titled "Advisor check-in N" and show the aggregator's question.

The card updates as the advisors work: the server follows each worker's
timeline, saves progress at most a few times a second, and publishes a
realtime signal per change; a running card also polls every few seconds. Rounds
are stored in the plugin's own database, removed when their MoA thread is
deleted, and a card only shows rounds that belong to the thread it is in.
Without the plugin loaded, the directive shows as plain text.

When a MoA turn finishes, the aggregator's steps fold into "Worked for" rows
but the advisor panels stay in view. Each panel is followed by a one-line
status message ("2 of 2 advisors answered. Claude Code · Sonnet 5 takes it
from here."), and BB keeps an assistant message visible in a folded turn when
the next message is one too. To see every step instead, turn Mixture of
Agents off under **Settings → Providers → Collapse finished turns** (or
`bb settings completed-turns moa flat`).

### Consulting again mid-task

A preset's **Consult them again mid-task** setting mirrors Hermes' `fanout`:

| Setting                          | What happens                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No, once per message is enough   | Advisors answer once, before the aggregator starts (Hermes' `user_turn`).                                     |
| When the aggregator asks         | The aggregator also gets a `moa_consult` tool and decides when to ask again, e.g. before a risky change.      |
| Every few tool calls (every N)   | As above, and the server tells the aggregator to call `moa_consult` every N tool calls (Hermes' `every_n:N`). |

`moa_consult` blocks while the advisors answer, like Hermes, and they get the
aggregator's question plus a summary of its work this turn (commands and
their output, diffs, messages). Each round gets its own advisor panel in the
MoA thread. A mid-task round is capped at four minutes.

The every-N check-in is sent with BB's ordinary steer, right after a tool
call finishes, so it works with any aggregator:

- **Claude Code, Codex, Pi** inject it into the running loop at the next step.
- **ACP agents** (Cursor, opencode, Grok, Antigravity): BB's ACP bridge
  cancels the in-flight prompt and continues with the check-in in the same
  turn, with full context.
- **Other plugin providers** apply it however their bridge handles steers.

An unanswered check-in holds off the next one for 2×N tool calls, so a
check-in that lands a step late is not followed by a second one. When an ACP
agent asks permission to run `moa_consult` (they gate every MCP tool), the
plugin grants it itself; the tool only reads.

Every slot runs as a **hidden BB worker thread** in the MoA thread's
environment, on its own provider and with that provider's own sign-in. No API
keys are involved. Workers are owned by the MoA thread (they archive and
delete with it) and are reused on later messages, so each keeps its own
context. If you change a preset's aggregator mid-thread, the old worker is
archived and the new one is briefed on the conversation so far.

## /moa from any thread

In a thread on any other provider (Claude Code, Codex, Pi, …), type
`/moa <question>` (it is in the composer's command menu; some providers use
`$moa`), or pick **Ask Mixture of Agents** from the composer's **+** menu.
Like Hermes' `/moa`, one question goes through your Mixture of Agents, and
that thread's own agent plays the aggregator:

1. The agent calls the `moa_ask` tool with your question and the context the
   advisors need (they cannot see the conversation). It returns at once.
2. The agent writes the advisor panel into its reply straight away, so you
   watch each advisor think and answer live.
3. The default preset's advisors (or a preset you name) answer in parallel,
   as hidden workers in that thread's workspace, owned by that thread and
   reused for its next question. They run in Accept Edits mode and are told
   not to change anything.
4. The agent waits for them with `moa_answers`, which returns their answers,
   or their progress after about three minutes so the agent can call it
   again. Then it answers you, weighing the advisors' notes, and starts that
   answer with the panel again: when the turn finishes, BB folds its steps
   and keeps only the final answer in view. Stopping the thread while it
   waits stops the advisors.

One thread's questions run one at a time. Only the advisors run; the preset's aggregator is not used. Threads
started before the plugin was installed or updated get `moa_ask` once their
session restarts.

## Using it

1. Install: `bb plugin install <path-or-git-url>`. On first load the plugin
   creates a **MoA Default** preset from your installed providers (Claude
   Code as aggregator, the next two as advisors).
2. Edit presets under **Settings → Plugins → Mixture of Agents**. Each slot
   uses BB's own provider/model/reasoning picker.
3. Choose **Mixture of Agents** and a preset in the model picker, or run
   `bb thread spawn --provider moa --model <preset-id> --prompt "…"`.

`bb moa list` prints the presets. Workers show up with
`bb thread list --include-hidden`; their titles start with `MoA advisor ·` or
`MoA aggregator ·`.

### Settings

| Setting                 | Default | Meaning                                                                          |
| ----------------------- | ------- | -------------------------------------------------------------------------------- |
| Advisor idle limit      | 180 s   | An advisor that shows no progress (no reasoning, output, or tool activity) for this long is stopped; what it had written still reaches the aggregator, marked as cut off. An advisor that keeps working is never cut off by this, but a round ends after 30 minutes and a mid-task round after 4. |
| Presets (settings page) | seeded  | Name, model id, description, aggregator slot, up to 6 advisor slots, on/off, mid-task consulting. |

### Compared with Hermes

| Hermes                        | This plugin                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `reference_models`            | Advisor slots: any BB provider and model, each with its own reasoning level     |
| `aggregator`                  | Aggregator slot: runs the provider's own agent harness and tools                |
| `fanout: user_turn`           | "No, once per message is enough" (the default)                                   |
| `fanout: every_n:N`           | "Every few tool calls": check-ins every N tool calls, answered with `moa_consult` |
| `fanout: per_iteration`       | Closest is every 1 tool call; the loop itself runs inside the provider           |
| —                             | "When the aggregator asks": `moa_consult` only, at the model's discretion        |
| `enabled: false`              | "Consult advisors first" off: the aggregator answers alone                       |
| References get no tools       | Advisors may read the workspace, and are told not to change it                   |
| Recursive presets blocked     | Same: a slot cannot use the Mixture of Agents provider                           |
| Temperatures, privacy filter  | Not available: providers own sampling, and advisors see only your own workspace  |

## Limitations

- Work the aggregator starts in the background, and anything it does after
  its turn ends (for example a background task that reports back later),
  stays in the hidden worker thread. Open the worker to see it.
- Items nested under the aggregator's own sub-agents are not mirrored; the
  sub-agent row and its summary are.
- MoA turns cannot be steered. A message sent mid-turn runs as the next turn.
- Check-ins count the aggregator's tool calls, not its model calls, so N is
  not exactly Hermes' iteration count. The aggregator has to act on a
  check-in; Claude Code and Cursor both did in testing.
- Changing a preset's mid-task setting takes effect on an existing MoA
  thread's next message: the aggregator's session is restarted to pick up
  (or drop) `moa_consult`.
- Advisors that ask to run something needing approval are denied, so a
  provider that needs approval just to read files gives thinner advice in
  Accept Edits mode.

## How it is built

- `server.ts` registers the provider (models come from the presets and are
  re-registered when you save), the settings RPC, `bb moa`, the internal
  `moa_turn` tool, and `moa_consult`. `src/agent-config.ts` offers
  `moa_turn` only to MoA threads and `moa_consult` only to aggregator workers
  whose preset consults mid-task (tagged through thread plugin metadata).
- `src/bridge.ts` is the provider bridge. It runs no model: on each turn it
  calls `moa_turn` through the runtime (`item/tool/call`, authenticated and
  routed for every enrolled machine), long-polls for results, validates each
  delta, and raises forwarded approvals with `interaction/request`.
- `src/runs.ts` orchestrates a turn with `bb.sdk.threads` (`spawn` with
  `environment: { type: "reuse" }`, `visibility: "hidden"`, and
  `lifecycleOwnerThreadId`; `send`, `events.list`, `interactions`, `stop`).
- `src/mirror.ts` turns the aggregator's stored timeline events back into
  `thread/delta` grammar, counts its tool calls, and keeps the work summary
  advisors see mid-task.
- `moa_ask` and `moa_answers` (in `server.ts`, run by `MoaRuns.startAsk` and
  `askAnswers`) serve `/moa`;
  the `moa` skill is the command, and `moa-threads` documents MoA threads.
- `src/rounds.ts` records advisor rounds (SQLite) for the panels, and
  `src/advisor-panel.tsx` is the `::moa-advisors` message directive.
- `app.tsx` registers that directive and the settings page, which is built on
  `experimental_ProviderModelPicker`.

## Development

```sh
npm install
npm run typecheck
npm test            # conformance, stream, orchestrator, and prompt tests
bb plugin build
bb plugin install . # path install; `bb plugin reload moa` after changes
```

`test/bridge.conformance.test.ts` runs BB's provider-bridge conformance suite
against the bridge, with a fake server answering `moa_turn`.
`test/bridge.stream.test.ts` feeds a recorded Claude Code turn through the
mirror, the bridge, and BB's own delta assembler. `test/runs.test.ts` drives
the orchestrator against a scripted stand-in for `bb.sdk`.

Built against `@get-bb/plugin-sdk` 0.5.9 (BB 0.43.4).
