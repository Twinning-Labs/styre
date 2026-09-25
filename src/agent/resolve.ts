import type { AgentConfig } from "../config/agent-config.ts";
import { claudeAgentRunner } from "./providers/claude.ts";
import { CODEX_CAPABILITIES } from "./providers/codex.ts";
import { selectAgentRunner } from "./registry.ts";
import type { AgentRunner, EffectiveCapabilities } from "./runner.ts";

/** Build the full built-in adapter map and select the configured provider (DEC-CX-5). The wiring
 *  layer (CLI entrypoints, smoke) — NOT the core control loop — is where providers are imported. */
export function resolveAgentRunner(config: AgentConfig): AgentRunner {
  return selectAgentRunner(config, {
    claude: () => claudeAgentRunner(config.command),
    // ENG-476: Codex cannot yet be confined (ENG-484), so the wired runner refuses before spawning
    // anything; the preflight refuses first, this is the defense in depth behind it. The adapter
    // (codexAgentRunner) stays in place and tested for ENG-484 to re-wire.
    codex: () => refusingRunner(CODEX_CAPABILITIES),
  });
}

/** A runner that never spawns: every run fails with the given capability report, which
 *  `launchAgent` turns into a confinement fault (a prerequisite failure, never a retry). */
function refusingRunner(capabilities: EffectiveCapabilities): AgentRunner {
  return {
    run: async () => ({
      completed: false,
      exitCode: null,
      stdout: "",
      stderr: capabilities.error ?? "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
      capabilities,
    }),
  };
}
