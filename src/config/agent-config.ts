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

export function parseAgentConfig(raw: unknown): AgentConfig {
  return AgentConfigSchema.parse(raw);
}

export function modelForTier(config: AgentConfig, tier: Tier): string {
  return config.models[tier];
}
