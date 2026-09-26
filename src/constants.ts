// Plain constants shared with the settings page. Kept free of zod so the
// frontend bundle, which loads in every BB window, does not pull it in.

/** This plugin's id, which namespaces its thread metadata. */
export const MOA_PLUGIN_ID = "moa-provider";

/** This plugin's own provider id; a preset slot may not point back at it. */
export const MOA_PROVIDER_ID = "moa";

export const MAX_ADVISORS = 6;

/** Largest "every N tool calls" a preset may ask for. */
export const MAX_FANOUT_EVERY = 50;

/** The tool an aggregator calls to ask its advisors mid-turn. */
export const CONSULT_TOOL_NAME = "moa_consult";

/** The tools any other thread's agent calls for `/moa <question>`. */
export const ASK_TOOL_NAME = "moa_ask";
export const ANSWERS_TOOL_NAME = "moa_answers";

export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u;

/** The message directive that embeds an advisor panel. */
export const ADVISOR_PANEL_DIRECTIVE = "moa-advisors";

/** Realtime channel: an advisor round changed (payload `{ id }`). */
export const ADVISOR_ROUND_CHANNEL = "advisor-round";

/** Advisor round ids: `<run uuid>:<round number>`. */
export const ROUND_ID_PATTERN = /^[0-9a-f-]{36}:\d{1,4}$/u;
