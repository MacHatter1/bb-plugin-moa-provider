// bb-plugin-moa-provider — MoA Provider: Mixture of Agents for BB.
//
// Registers a "Mixture of Agents" provider whose models are the user's
// presets. A preset pairs advisor slots with an aggregator slot, each any
// installed BB provider and model. The provider's bridge (src/bridge.ts)
// hands every turn to this server through the internal `moa_turn` tool, and
// src/runs.ts runs the advisors and the aggregator as hidden worker threads.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type PluginProviderDeclaration,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { agentConfiguration } from "./src/agent-config.js";
import {
  ADVISOR_ROUND_CHANNEL,
  ANSWERS_TOOL_NAME,
  ASK_TOOL_NAME,
  CONSULT_TOOL_NAME,
  PRESET_ID_PATTERN,
  ROUND_ID_PATTERN,
} from "./src/constants.js";
import {
  EMPTY_STORE,
  activeAdvisors,
  consultsMidTurn,
  defaultPresetId,
  presetStoreSchema,
  type Preset,
  type PresetStore,
  type ReasoningLevel,
  type Slot,
} from "./src/presets.js";
import {
  ANSWERS_TOOL_DESCRIPTION,
  ASK_TOOL_DESCRIPTION,
  ASK_TOOL_INSTRUCTIONS,
  CONSULT_TOOL_DESCRIPTION,
  CONSULT_TOOL_INSTRUCTIONS,
} from "./src/prompts.js";
import { advisorRoundSchema, sqliteRoundStore } from "./src/rounds.js";
import { MoaRuns } from "./src/runs.js";
import {
  MOA_TOOL_NAME,
  PROVIDER_ID,
  toolArgsSchema,
  type MoaProviderOptions,
} from "./src/wire.js";

const PRESETS_KEY = "presets";
const PRESETS_CHANGED = "presets-changed";

export const rpcContract = defineRpcContract({
  presets_get: {
    input: z.null(),
    output: z.object({ store: presetStoreSchema }),
  },
  presets_save: {
    input: z.object({ store: presetStoreSchema }),
    output: z.object({ store: presetStoreSchema }),
  },
  /** One advisor round, for its `::moa-advisors` panel in that MoA thread. */
  advisor_round_get: {
    input: z.object({
      id: z.string().regex(ROUND_ID_PATTERN),
      threadId: z.string().min(1),
    }),
    output: z.object({ round: advisorRoundSchema.nullable() }),
  },
});

/** How often a preset's advisors are asked, in words. */
function describeFanout(preset: Preset): string {
  if (!consultsMidTurn(preset)) return "";
  return preset.fanout === "every-n"
    ? `, rechecked every ${preset.fanoutEvery} tool call${preset.fanoutEvery === 1 ? "" : "s"}`
    : ", on request mid-task";
}

/** The picker entry for one preset. Reasoning is set per slot, not here. */
function catalogModel(preset: Preset, isDefault: boolean) {
  const advisors = activeAdvisors(preset).length;
  const summary = `${preset.aggregator.model} with ${
    advisors === 0 ? "no advisors" : `${advisors} advisor${advisors === 1 ? "" : "s"}`
  }${describeFanout(preset)}`;
  return {
    id: preset.id,
    model: preset.id,
    displayName: preset.name,
    description: preset.description.trim() === "" ? summary : preset.description,
    supportedReasoningEfforts: [
      {
        reasoningEffort: "medium" as const,
        description: "Each slot uses the reasoning level set in its preset",
      },
    ],
    defaultReasoningEffort: "medium" as const,
    isDefault,
  };
}

function providerDeclaration(store: PresetStore): PluginProviderDeclaration {
  const defaultId = defaultPresetId(store);
  const models = store.presets.map((preset) =>
    catalogModel(preset, preset.id === defaultId),
  );
  return {
    id: PROVIDER_ID,
    displayName: "Mixture of Agents",
    icon: "./icons/moa.svg",
    // model/list answers from these; a preset change re-registers them.
    experimental_bridgeOptions: { models },
    maintenance: { health: false, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits", "auto", "full"],
      reasoningLevels: ["medium"],
    },
    reasoningLevels: [{ id: "medium", label: "Per slot" }],
    composerActions: [],
    // Finished turns fold the aggregator's steps; advisor panels stay in
    // view because each is followed by a status message (src/runs.ts).
    completedTurnDisplay: "collapse",
    strings: {
      signInHint:
        "Mixture of Agents uses the providers in its presets. Sign in to each of them.",
      expiredHint:
        "A provider in this preset needs you to sign in again. Check Settings → Providers.",
      installUrl: "https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents",
    },
    models: { fallback: models, scope: "host" },
    deriveProviderOptions(context): MoaProviderOptions {
      return { presetId: context.model, permissionMode: context.permissionMode };
    },
  };
}

function describeSlot(slot: Slot): string {
  return `${slot.providerId} / ${slot.model} (${slot.reasoningLevel})`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    // Key kept from when this was a fixed time limit, so saved values carry over.
    advisorTimeoutSeconds: {
      type: "number",
      label: "Advisor idle limit (seconds)",
      description:
        "Stop an advisor that shows no progress (no new reasoning, text, or tool activity) for this long. Advisors that keep working are not cut off, up to 30 minutes. What a stopped advisor wrote is kept.",
      default: 180,
      experimental_schema: z.number().int().min(30).max(1800),
    },
  });

  async function loadStore(): Promise<PresetStore> {
    const raw = await bb.storage.kv.get<unknown>(PRESETS_KEY);
    if (raw === null || raw === undefined) return EMPTY_STORE;
    const parsed = presetStoreSchema.safeParse(raw);
    if (!parsed.success) {
      bb.log.error(`stored presets are invalid: ${parsed.error.message}`);
      return EMPTY_STORE;
    }
    return parsed.data;
  }

  let provider = bb.providers.register(providerDeclaration(await loadStore()));

  async function saveStore(store: PresetStore): Promise<PresetStore> {
    const valid = presetStoreSchema.parse(store);
    await bb.storage.kv.set(PRESETS_KEY, valid);
    provider.dispose();
    provider = bb.providers.register(providerDeclaration(valid));
    bb.realtime.publish(PRESETS_CHANGED, { count: valid.presets.length });
    return valid;
  }

  /** First run: one "Default" preset from whichever providers are installed. */
  async function seedDefaultPreset(): Promise<void> {
    if ((await bb.storage.kv.get<unknown>(PRESETS_KEY)) != null) return;
    const available = (await bb.sdk.providers.list()).filter(
      (entry) => entry.available && entry.id !== PROVIDER_ID,
    );
    const preferred = ["claude-code", "codex", "pi"];
    available.sort(
      (a, b) =>
        (preferred.indexOf(a.id) + 1 || 99) - (preferred.indexOf(b.id) + 1 || 99),
    );
    const slots: Slot[] = [];
    for (const entry of available) {
      if (slots.length === 3) break;
      const catalog = await bb.sdk.providers
        .models({ providerId: entry.id })
        .catch(() => null);
      const model =
        catalog?.models.find((candidate) => candidate.isDefault) ?? catalog?.models[0];
      if (model === undefined) continue;
      slots.push({
        providerId: entry.id,
        model: model.id,
        reasoningLevel: model.defaultReasoningEffort as ReasoningLevel,
      });
    }
    const [aggregator, ...advisors] = slots;
    if (aggregator === undefined) return;
    await saveStore({
      version: 1,
      defaultPresetId: "default",
      presets: [
        {
          id: "default",
          name: "MoA Default",
          description: "",
          aggregator,
          advisors,
          advisorsEnabled: true,
          fanout: "message",
          fanoutEvery: 5,
        },
      ],
    });
    bb.log.info(`seeded the default preset with ${slots.length} slots`);
  }

  const rounds = sqliteRoundStore(bb.storage.database(), bb.storage.migrate);
  const runs = new MoaRuns({
    sdk: () => bb.sdk,
    loadStore,
    advisorIdleMs: async () => (await settings.get()).advisorTimeoutSeconds * 1000,
    kv: bb.storage.kv,
    log: bb.log,
    rounds,
    publishRound: (id) => bb.realtime.publish(ADVISOR_ROUND_CHANNEL, { id }),
  });

  // The bridge's channel to this server. Only MoA threads are offered it.
  bb.agents.registerTool({
    name: MOA_TOOL_NAME,
    description:
      "Internal channel between the Mixture of Agents provider bridge and its plugin server. Not for agents.",
    parameters: z
      .object({ op: z.enum(["start", "poll", "resolve", "interrupt"]) })
      .passthrough(),
    async execute(raw, ctx) {
      const args = toolArgsSchema.parse(raw);
      switch (args.op) {
        case "start":
          return JSON.stringify({ runId: runs.start(ctx.threadId, args) });
        case "poll":
          return JSON.stringify(
            await runs.poll(ctx.threadId, args.runId, args.cursor, args.waitMs, ctx.signal),
          );
        case "resolve":
          return JSON.stringify({
            ok: await runs.resolve(ctx.threadId, args.runId, args.requestId, args.resolution),
          });
        case "interrupt":
          runs.interrupt(ctx.threadId, args.runId);
          return JSON.stringify({ ok: true });
      }
    },
  });
  // The aggregator's way to ask its advisors mid-turn. Offered only to
  // aggregator workers of presets with a mid-turn fanout (src/agent-config.ts).
  bb.agents.registerTool({
    name: CONSULT_TOOL_NAME,
    description: CONSULT_TOOL_DESCRIPTION,
    instructions: CONSULT_TOOL_INSTRUCTIONS,
    presentation: {
      label: { pending: "Consulting advisors", completed: "Consulted advisors" },
      icon: { glyph: "Lightbulb" },
    },
    parameters: z.object({
      question: z
        .string()
        .trim()
        .min(1)
        .max(8_000)
        .describe(
          "What you want advice on, with what you have found so far and what you plan to do next.",
        ),
    }),
    execute: ({ question }, ctx) => runs.consultAdvisors(ctx.threadId, question, ctx.signal),
  });

  // `/moa <question>` from any other thread: that thread's agent asks the
  // default preset's advisors and plays the aggregator itself. Asking returns
  // at once so the agent can show the live panel; waiting is a second call.
  bb.agents.registerTool({
    name: ASK_TOOL_NAME,
    description: ASK_TOOL_DESCRIPTION,
    instructions: ASK_TOOL_INSTRUCTIONS,
    presentation: {
      label: { pending: "Asking Mixture of Agents", completed: "Asked Mixture of Agents" },
      icon: { glyph: "Lightbulb" },
    },
    parameters: z.object({
      question: z
        .string()
        .trim()
        .min(1)
        .max(8_000)
        .describe("The user's question for the advisors, in their words."),
      context: z
        .string()
        .max(20_000)
        .optional()
        .describe(
          "What the advisors need to know, since they cannot see this conversation: the goal, relevant files and findings, what has been tried.",
        ),
      preset: z
        .string()
        .regex(PRESET_ID_PATTERN)
        .optional()
        .describe("A Mixture of Agents preset id, only when the user names one. Defaults to the default preset."),
    }),
    execute: ({ question, context, preset }, ctx) =>
      runs.startAsk({
        threadId: ctx.threadId,
        question,
        context: context ?? null,
        presetId: preset ?? null,
      }),
  });
  bb.agents.registerTool({
    name: ANSWERS_TOOL_NAME,
    description: ANSWERS_TOOL_DESCRIPTION,
    presentation: {
      label: { pending: "Waiting for the advisors", completed: "Heard from the advisors" },
      icon: { glyph: "Lightbulb" },
    },
    parameters: z.object({
      round: z.string().regex(ROUND_ID_PATTERN).describe("The round moa_ask returned."),
    }),
    execute: ({ round }, ctx) => runs.askAnswers(ctx.threadId, round, ctx.signal),
  });

  // Selecting tools here also selects skills (src/agent-config.ts).
  bb.agents.configure(agentConfiguration);

  bb.rpc.register(rpcContract, {
    presets_get: async () => ({ store: await loadStore() }),
    presets_save: async ({ store }) => ({ store: await saveStore(store) }),
    // A panel shows only rounds of the thread it is embedded in.
    advisor_round_get: ({ id, threadId }) => {
      const round = rounds.get(id);
      return { round: round?.moaThreadId === threadId ? round : null };
    },
  });

  bb.cli.register(
    defineCli({
      name: "moa-provider",
      summary: "Inspect Mixture of Agents presets",
      commands: {
        list: cliCommand({
          summary: "List presets: the models of the moa provider",
          options: {
            json: { type: "boolean", description: "Emit machine-readable JSON" },
          },
          async run(input) {
            const store = await loadStore();
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(store) };
            }
            if (store.presets.length === 0) {
              throw new PluginCliError("No presets yet.", {
                code: "no_presets",
                hint: "Create one under Settings → Plugins → MoA Provider.",
              });
            }
            const defaultId = defaultPresetId(store);
            const lines = store.presets.flatMap((preset) => [
              `${preset.id}${preset.id === defaultId ? " (default)" : ""} — ${preset.name}`,
              `  aggregator: ${describeSlot(preset.aggregator)}`,
              ...(consultsMidTurn(preset)
                ? [`  advisors asked: once per message${describeFanout(preset)}`]
                : []),
              ...(activeAdvisors(preset).length === 0
                ? ["  advisors: none"]
                : activeAdvisors(preset).map((slot) => `  advisor:    ${describeSlot(slot)}`)),
            ]);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
      },
    }),
  );

  // A MoA thread that settles (stop, failure, or a normal end) takes any
  // still-running workers with it.
  bb.events.on("thread.idle", ({ thread }) => runs.onThreadSettled(thread.id));
  bb.events.on("thread.failed", ({ thread }) => runs.onThreadSettled(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => runs.forgetThread(thread.id));

  bb.background.service("runs", {
    async start(signal) {
      await seedDefaultPreset().catch((error: unknown) =>
        bb.log.warn(`could not seed a default preset: ${String(error)}`),
      );
      while (!signal.aborted) {
        runs.sweep();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  bb.onDispose(() => {
    runs.dispose();
    provider.dispose();
  });
}
