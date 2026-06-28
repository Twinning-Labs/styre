import discoverTemplate from "../../prompts/setup-discover.md" with { type: "text" };
import type { AgentRunner } from "../agent/runner.ts";
import { type AgentConfig, modelForTier } from "../config/agent-config.ts";
import type { Component } from "../dispatch/profile.ts";
import { renderPrompt } from "../dispatch/render-prompt.ts";
import { extractSidecar } from "../dispatch/sidecar.ts";
import { allowlistFor } from "../dispatch/tool-allowlists.ts";
import { isCommandSafe } from "./command-safety.ts";
import { DiscoverSchema, mergeComponents, probeCommandExists } from "./discover-schema.ts";

const DISCOVER_TIMEOUT_MS = 300_000;

export interface DiscoverPolicy {
  interactive: boolean;
  trustAgentCommands: boolean;
}

export async function discoverComponents(
  repoDir: string,
  scan: { components: Component[]; repoCommands: Record<string, string> },
  deps: { runner: AgentRunner; agentConfig: AgentConfig },
  policy: DiscoverPolicy = { interactive: true, trustAgentCommands: false },
): Promise<{ components: Component[]; repoCommands: Record<string, string>; warnings: string[] }> {
  const warnings: string[] = [];
  const fallback = { components: scan.components, repoCommands: scan.repoCommands, warnings };

  const rendered = renderPrompt(discoverTemplate, { draft: JSON.stringify(scan.components) });
  if (!rendered.ok) return fallback;
  const result = await deps.runner.run({
    prompt: rendered.prompt,
    model: modelForTier(deps.agentConfig, "standard"),
    allowedTools: allowlistFor("setup:discover"),
    cwd: repoDir,
    timeoutMs: DISCOVER_TIMEOUT_MS,
  });
  if (!result.completed || result.timedOut) return fallback;
  const parsed = extractSidecar(result.stdout, DiscoverSchema, { fence: "styre-setup-discover" });
  if (!parsed.ok) return fallback;

  const trusted = policy.interactive || policy.trustAgentCommands;
  const scanByName = new Map(scan.components.map((c) => [c.name, c]));
  const agentByName = new Map((parsed.value.components as Component[]).map((c) => [c.name, c]));
  const merged = mergeComponents(scan.components, parsed.value.components as Component[]);

  const components = merged.map((c) => {
    const scanCmds = scanByName.get(c.name)?.commands ?? {};
    const agentCmds = agentByName.get(c.name)?.commands ?? {};
    const commands: Component["commands"] = {};
    for (const [key, value] of Object.entries(c.commands)) {
      if (typeof value !== "string") {
        commands[key] = value; // { unavailable: true } — untouched
        continue;
      }
      if (!(key in agentCmds)) {
        commands[key] = value; // machine/scan command — keep
        continue;
      }
      const scanVal = typeof scanCmds[key] === "string" ? (scanCmds[key] as string) : undefined;
      const accept = isCommandSafe(value) && probeCommandExists(repoDir, value) && trusted;
      if (accept) {
        commands[key] = value;
        continue;
      }
      // rejected — explain why, then fall back to the machine candidate or omit the slot
      if (!isCommandSafe(value)) {
        warnings.push(`⚠ ${c.name}.${key}: agent command has shell metacharacters — rejected.`);
      } else if (!trusted) {
        warnings.push(
          `⚠ ${c.name}.${key}: headless — agent override not accepted (use --trust-agent-commands).`,
        );
      }
      if (scanVal !== undefined) commands[key] = scanVal;
      else warnings.push(`⚠ ${c.name}.${key}: dropped (no detected command).`);
    }
    return { ...c, commands };
  });

  // repoCommands: wholly agent-authored; previously unprobed + ungated (F2).
  const repoCommands: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(parsed.value.repoCommands)) {
    if (!isCommandSafe(cmd)) {
      warnings.push(`⚠ repoCommand ${name}: shell metacharacters — dropped.`);
      continue;
    }
    if (!probeCommandExists(repoDir, cmd)) {
      warnings.push(`⚠ repoCommand ${name}: command not found — dropped.`);
      continue;
    }
    if (!trusted) {
      warnings.push(`⚠ repoCommand ${name}: headless — dropped (use --trust-agent-commands).`);
      continue;
    }
    repoCommands[name] = cmd;
  }

  return { components, repoCommands, warnings };
}
