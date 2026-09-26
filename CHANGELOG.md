# Changelog

All notable changes to MoA Provider are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/).

## Unreleased

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
