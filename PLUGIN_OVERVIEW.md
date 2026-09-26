Put several agents on one message. Mixture of Agents adds a provider to the
model picker whose models are your presets: advisor agents look at the
request first, then an aggregator agent reads their notes and does the work.

## What you get

- A **Mixture of Agents** provider, with one model per preset.
- A **Presets** page in this plugin's settings: pick the aggregator and up to
  six advisors from any installed provider and model, with their reasoning
  levels.
- Advisor answers appear as sub-agent rows in the thread. The aggregator's
  commands, edits, approvals, and reply appear as if the thread ran them
  itself.

## How it works

Each slot runs as a hidden thread on its own provider, in the same workspace,
using that provider's existing sign-in. Advisors run in parallel, once per
message, and are told not to change anything. The hidden threads belong to
the Mixture of Agents thread and are archived and deleted with it.

Every message costs one turn per advisor plus the aggregator's full turn.
