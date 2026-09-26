# Changelog

All notable changes to MoA Provider are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- `/moa` from a Cursor or Codex thread no longer stops the advisors after a
  minute. Those clients cancel a tool call after 60 seconds, and a cancelled
  `moa_answers` wait used to stop the round. The wait now reports progress
  after 45 seconds, a cancelled wait leaves the advisors working, and a round
  stops when the turn that asked for it ends.
- Mid-task check-ins with a Cursor or Codex aggregator no longer stop after a
  minute for the same reason. `moa_consult` reports progress after 45 seconds,
  a cancelled call leaves the check-in running, and the next call waits on the
  same check-in.

## 0.1.0 - 2026-09-26

### Added

- A **Mixture of Agents** provider in the model picker, with one model per
  preset: each preset pairs up to six advisor slots with one aggregator slot,
  and any installed BB provider and model can fill a slot.
- Advisors answer your message in parallel as hidden worker threads, told to
  change nothing and to keep to the workspace, and the aggregator receives
  their notes as a private block before it does the work.
- A live advisor panel in the thread (`::moa-advisors`), with one row per
  advisor: model, reasoning level, status, what it is doing (with workspace
  paths relative and your home as `~`), and its answer as it streams. Where a
  round appears twice, only the last copy is shown in full.
- The aggregator's reasoning, commands, file changes, approvals and reply
  mirrored into the MoA thread as they happen.
- Mid-task consulting: the `moa_consult` tool, and optional check-ins every N
  tool calls.
- `/moa <question>` in any other thread, and **Ask MoA** in the composer's
  **+** menu, with the `moa_ask` and `moa_answers` tools, so that thread's own
  agent plays the aggregator.
- A **Presets** page in the plugin's settings, built on BB's own
  provider/model picker.
- `bb moa-provider list` to print the presets, and the `moa` and
  `moa-threads` skills.
