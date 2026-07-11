import { z } from "zod";
import type { Tier } from "../agent/tiers.ts";

/** Agent provider + per-tier model ids (DEC-AG-3). Lives in workspace config; the binary
 *  default is the Claude preset. The core resolves a step's model via the tier, never a
 *  hardcoded id. */
export const AgentConfigSchema = z.object({
  provider: z.string(),
  command: z.string().optional(),
  models: z.object({
    deep: z.string(),
    standard: z.string(),
    cheap: z.string(),
  }),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  provider: "claude",
  command: "claude",
  models: {
    deep: "claude-opus-4-8",
    standard: "claude-sonnet-4-6",
    cheap: "claude-haiku-4-5-20251001",
  },
};

/** Built-in Codex preset (DEC-CX-7). Model ids are OPERATOR-SET config, not core truth — these are
 *  drop-in defaults to confirm/override in workspace config.json. */
export const CODEX_PRESET: AgentConfig = {
  provider: "codex",
  command: "codex",
  models: { deep: "gpt-5.4", standard: "gpt-5.4-codex", cheap: "gpt-5.4-codex-mini" },
};

export function parseAgentConfig(raw: unknown): AgentConfig {
  return AgentConfigSchema.parse(raw);
}

export function modelForTier(config: AgentConfig, tier: Tier): string {
  return config.models[tier];
}

/** Provider → the env var it needs to authenticate its CLI (DEC-CX-6). Used by the setup gate. */
const PROVIDER_REQUIRED_ENV: Record<string, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};

export function requiredEnvFor(provider: string): string | undefined {
  return PROVIDER_REQUIRED_ENV[provider];
}
