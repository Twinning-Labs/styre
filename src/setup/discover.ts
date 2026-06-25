import discoverTemplate from "../../prompts/setup-discover.md" with { type: "text" };
import type { AgentRunner } from "../agent/runner.ts";
import { type AgentConfig, modelForTier } from "../config/agent-config.ts";
import type { Component } from "../dispatch/profile.ts";
import { renderPrompt } from "../dispatch/render-prompt.ts";
import { extractSidecar } from "../dispatch/sidecar.ts";
import { allowlistFor } from "../dispatch/tool-allowlists.ts";
import { DiscoverSchema, mergeComponents, probeCommandExists } from "./discover-schema.ts";

const DISCOVER_TIMEOUT_MS = 300_000;

/** Refine the deterministic component skeleton with a read-only agent, reconcile against the scan,
 *  and drop commands that fail the existence probe. Falls back to the scan on agent failure. */
export async function discoverComponents(
  repoDir: string,
  scan: { components: Component[]; repoCommands: Record<string, string> },
  deps: { runner: AgentRunner; agentConfig: AgentConfig },
): Promise<{ components: Component[]; repoCommands: Record<string, string> }> {
  const rendered = renderPrompt(discoverTemplate, { draft: JSON.stringify(scan.components) });
  if (!rendered.ok) return scan;
  const result = await deps.runner.run({
    prompt: rendered.prompt,
    model: modelForTier(deps.agentConfig, "standard"),
    allowedTools: allowlistFor("setup:discover"),
    cwd: repoDir,
    timeoutMs: DISCOVER_TIMEOUT_MS,
  });
  if (!result.completed || result.timedOut) return scan;
  const parsed = extractSidecar(result.stdout, DiscoverSchema, { fence: "styre-setup-discover" });
  if (!parsed.ok) return scan;

  const merged = mergeComponents(scan.components, parsed.value.components as Component[]);
  // Drop probe-failing commands (typo/missing tool) — they become absent, to be resolved by the ladder.
  const components = merged.map((c) => ({
    ...c,
    commands: Object.fromEntries(
      Object.entries(c.commands).filter(([, v]) =>
        typeof v === "string" ? probeCommandExists(repoDir, v) : true,
      ),
    ),
  }));
  return { components, repoCommands: parsed.value.repoCommands };
}
