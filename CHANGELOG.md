# Changelog

All notable changes to Mixture of Agents are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- The advisor panel no longer shows your home directory while an advisor
  works: paths in the workspace are shown relative to it, other paths under
  your home start with `~`, and a leading `cd <workspace> &&` is dropped.
- A `/moa` round shown twice in a thread whose finished turns stay flat, as
  Claude Code's do, now appears in full only once. The earlier copy shrinks to
  one line that scrolls to it.
- A panel the thread view re-mounts shows its round straight away, instead of
  "Loading advisors…".
- The `moa_ask` instructions tell agents whose tools are deferred to load the
  schemas first, so the first call no longer fails with no arguments.

## 0.1.0 - 2026-09-26

### Added

- A **Mixture of Agents** provider in the model picker, with one model per
  preset: each preset pairs up to six advisor slots with one aggregator slot,
  and any installed BB provider and model can fill a slot.
- Advisors answer your message in parallel as hidden worker threads, and the
  aggregator receives their notes as a private block before it does the work.
- A live advisor panel in the thread (`::moa-advisors`), with one row per
  advisor: model, reasoning level, status, what it is doing, and its answer as
  it streams.
- The aggregator's reasoning, commands, file changes, approvals and reply
  mirrored into the MoA thread as they happen.
- Mid-task consulting: the `moa_consult` tool, and optional check-ins every N
  tool calls.
- `/moa <question>` in any other thread, with the `moa_ask` and `moa_answers`
  tools, so that thread's own agent plays the aggregator.
- A **Presets** page in the plugin's settings, built on BB's own
  provider/model picker.
- `bb moa list` to print the presets, and the `moa` and `moa-threads` skills.
