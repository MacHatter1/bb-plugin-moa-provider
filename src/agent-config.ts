// Which of this plugin's tools and skills each thread gets. Worker threads
// are tagged through this plugin's thread metadata (`role`, `consult`).
// Metadata is writable by anyone, so it only unlocks what is harmless on any
// thread: `moa_consult` answers nothing unless its caller is the aggregator of
// a live MoA run.
import {
  ANSWERS_TOOL_NAME,
  ASK_TOOL_NAME,
  CONSULT_TOOL_NAME,
  MOA_PROVIDER_ID,
} from "./constants.js";
import { MOA_TOOL_NAME } from "./wire.js";

export interface AgentConfigurationContext {
  provider: { id: string };
  pluginMetadata: { readonly [key: string]: unknown };
}

export function agentConfiguration(context: AgentConfigurationContext): {
  tools: string[];
  skills: string[];
} {
  const { role, consult } = context.pluginMetadata;
  const worker = role === "advisor" || role === "aggregator";
  const moaThread = context.provider.id === MOA_PROVIDER_ID;
  return {
    tools: [
      // The bridge's channel to the server, for MoA threads only.
      ...(moaThread ? [MOA_TOOL_NAME] : []),
      ...(role === "aggregator" && consult === true ? [CONSULT_TOOL_NAME] : []),
      // `/moa <question>` from any ordinary thread.
      ...(!moaThread && !worker ? [ASK_TOOL_NAME, ANSWERS_TOOL_NAME] : []),
    ],
    // Workers have a job to do; the skills are for everyone else.
    skills: worker ? [] : ["moa", "moa-threads"],
  };
}
