import type { AgentConfig } from "../config/agent-config.ts";
import { claudeAgentRunner } from "./providers/claude.ts";
import { codexAgentRunner } from "./providers/codex.ts";
import { selectAgentRunner } from "./registry.ts";
import type { AgentRunner } from "./runner.ts";

/** Build the full built-in adapter map and select the configured provider (DEC-CX-5). The wiring
 *  layer (CLI entrypoints, smoke) — NOT the core control loop — is where providers are imported. */
export function resolveAgentRunner(config: AgentConfig): AgentRunner {
  return selectAgentRunner(config, {
    claude: () => claudeAgentRunner(config.command),
    codex: () => codexAgentRunner(config.command),
  });
}
