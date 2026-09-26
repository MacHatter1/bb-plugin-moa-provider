// Preset model shared by the server, the settings page (type-only), and the
// CLI. A preset is one "virtual model" in the MoA provider's picker: a list of
// advisor slots that answer first, and an aggregator slot that does the work.
import { z } from "zod";
import {
  MAX_ADVISORS,
  MAX_FANOUT_EVERY,
  MOA_PROVIDER_ID,
  PRESET_ID_PATTERN,
} from "./constants.js";

export { MAX_ADVISORS, MAX_FANOUT_EVERY, MOA_PROVIDER_ID, PRESET_ID_PATTERN };

export const REASONING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
] as const;

export const reasoningLevelSchema = z.enum(REASONING_LEVELS);
export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

/** One provider + model pairing, as `experimental_ProviderModelPicker` emits it. */
export const slotSchema = z.object({
  providerId: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (id) => id !== MOA_PROVIDER_ID,
      "A preset cannot use Mixture of Agents itself as a slot",
    ),
  model: z.string().min(1, "Choose a model").max(200),
  reasoningLevel: reasoningLevelSchema,
  serviceTier: z.enum(["default", "fast"]).optional(),
});
export type Slot = z.infer<typeof slotSchema>;

export const FANOUTS = ["message", "on-request", "every-n"] as const;
export const fanoutSchema = z.enum(FANOUTS);
export type Fanout = z.infer<typeof fanoutSchema>;

export const presetSchema = z.object({
  id: z
    .string()
    .regex(
      PRESET_ID_PATTERN,
      "Use 1-48 lowercase letters, digits, or dashes, starting with a letter or digit",
    ),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(240),
  aggregator: slotSchema,
  advisors: z.array(slotSchema).max(MAX_ADVISORS),
  /** Off: the aggregator answers alone, like Hermes' `enabled: false`. */
  advisorsEnabled: z.boolean(),
  /**
   * When advisors run, like Hermes' `fanout`. Every mode consults them once
   * per message; `on-request` also gives the aggregator a `moa_consult` tool,
   * and `every-n` additionally nudges it to call that tool every
   * `fanoutEvery` tool calls.
   */
  fanout: fanoutSchema.default("message"),
  fanoutEvery: z.number().int().min(1).max(MAX_FANOUT_EVERY).default(5),
});
export type Preset = z.infer<typeof presetSchema>;

export const presetStoreSchema = z
  .object({
    version: z.literal(1),
    defaultPresetId: z.string().nullable(),
    presets: z.array(presetSchema).max(32),
  })
  .superRefine((store, ctx) => {
    const ids = new Set<string>();
    store.presets.forEach((preset, index) => {
      if (ids.has(preset.id)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate preset id "${preset.id}"`,
          path: ["presets", index, "id"],
        });
      }
      ids.add(preset.id);
    });
    if (store.defaultPresetId !== null && !ids.has(store.defaultPresetId)) {
      ctx.addIssue({
        code: "custom",
        message: `Default preset "${store.defaultPresetId}" does not exist`,
        path: ["defaultPresetId"],
      });
    }
  });
export type PresetStore = z.infer<typeof presetStoreSchema>;

export const EMPTY_STORE: PresetStore = {
  version: 1,
  defaultPresetId: null,
  presets: [],
};

export function findPreset(store: PresetStore, presetId: string): Preset | null {
  return store.presets.find((preset) => preset.id === presetId) ?? null;
}

/** The explicit default when it still exists, else the first preset. */
export function defaultPresetId(store: PresetStore): string | null {
  if (
    store.defaultPresetId !== null &&
    store.presets.some((preset) => preset.id === store.defaultPresetId)
  ) {
    return store.defaultPresetId;
  }
  return store.presets[0]?.id ?? null;
}

/** Stable identity of a slot: a worker thread is reused while this matches. */
export function slotSignature(slot: Slot): string {
  return [
    slot.providerId,
    slot.model,
    slot.reasoningLevel,
    slot.serviceTier ?? "",
  ].join("|");
}

export function activeAdvisors(preset: Preset): Slot[] {
  return preset.advisorsEnabled ? preset.advisors : [];
}

/** Whether the aggregator gets `moa_consult`: a mid-turn mode with advisors. */
export function consultsMidTurn(preset: Preset): boolean {
  return preset.fanout !== "message" && activeAdvisors(preset).length > 0;
}
