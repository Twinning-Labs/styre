import type { AgentConfig } from "../config/agent-config.ts";
import type { AgentRunner } from "./runner.ts";

export type AdapterFactory = () => AgentRunner;

/** Pick the agent adapter for the configured provider. The daemon supplies the adapter map
 *  (e.g. `{ claude: () => claudeAgentRunner(config.command) }`); tests supply a fake. An
 *  unregistered provider is a setup error (GOAL-INSTALL touchpoint). The core never imports
 *  a provider directly. */
export function selectAgentRunner(
  config: AgentConfig,
  adapters: Record<string, AdapterFactory>,
): AgentRunner {
  const factory = adapters[config.provider];
  if (!factory) {
    throw new Error(`selectAgentRunner: no adapter registered for provider '${config.provider}'`);
  }
  return factory();
}
