import setupEnrichTemplate from "../../prompts/setup-enrich.md" with { type: "text" };
import type { AgentRunner } from "../agent/runner.ts";
import type { AgentConfig } from "../config/agent-config.ts";
import { modelForTier } from "../config/agent-config.ts";
import type { RuntimeContext } from "../dispatch/profile.ts";
import { renderPrompt } from "../dispatch/render-prompt.ts";
import { extractSidecar } from "../dispatch/sidecar.ts";
import { allowlistFor } from "../dispatch/tool-allowlists.ts";
import { EnrichmentSchema } from "./enrichment-schema.ts";
import { mergeScanAndEnrichment } from "./merge.ts";

export type EnrichDeps = {
  runner: AgentRunner;
  agentConfig: AgentConfig;
  /** Injected so tests skip real backoff; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
};

const ENRICH_TIMEOUT_MS = 300_000; // 5 min
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 8_000];
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Seed the scan findings into the enrichment prompt. */
function enrichVars(scan: RuntimeContext): Record<string, string> {
  return {
    scan_topology: scan.topology.type,
    scan_topology_detail: scan.topology.detail,
    scan_data: scan.data.presence,
    scan_data_detail: scan.data.detail,
    scan_data_migration_tool: scan.data.migrationTool ?? "",
    scan_caching: scan.caching.presence,
    scan_caching_detail: scan.caching.detail,
    scan_observability: scan.observability.presence,
    scan_observability_detail: scan.observability.detail,
    scan_config_secrets: scan.configSecrets.presence,
    scan_config_secrets_detail: scan.configSecrets.detail,
    scan_documentation: scan.documentation.presence,
    scan_documentation_detail: scan.documentation.detail,
    scan_release: scan.releasePackaging.mechanism,
    scan_release_detail: scan.releasePackaging.detail,
  };
}

/** Mandatory setup-time agent enrichment (E1). Bounded retry-then-fail (E2): on exhaustion this
 *  throws, and the caller writes no profile. Scan flags stay ground truth — the merge only lets
 *  the agent enrich detail and resolve `unknown` sections (E5). */
export async function enrichRuntimeContext(
  repoDir: string,
  scan: RuntimeContext,
  deps: EnrichDeps,
): Promise<RuntimeContext> {
  const sleep = deps.sleep ?? realSleep;
  const model = modelForTier(deps.agentConfig, "standard");
  const allowedTools = allowlistFor("setup:enrich");
  const prompt = renderPrompt(setupEnrichTemplate, enrichVars(scan));

  if (!prompt.ok) {
    throw new Error(`enrichRuntimeContext: unresolved prompt vars: ${prompt.missing.join(", ")}`);
  }

  let lastReason = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await deps.runner.run({
      prompt: prompt.prompt,
      model,
      allowedTools,
      cwd: repoDir,
      timeoutMs: ENRICH_TIMEOUT_MS,
    });
    if (result.completed && !result.timedOut) {
      const parsed = extractSidecar(result.stdout, EnrichmentSchema, {
        fence: "styre-setup-enrich",
      });
      if (parsed.ok) return mergeScanAndEnrichment(scan, parsed.value);
      lastReason = `sidecar ${parsed.reason}: ${parsed.detail}`;
    } else {
      lastReason = result.timedOut ? "timed out" : `exit ${result.exitCode}`;
    }
    if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_MS[attempt - 1] ?? 0);
  }
  throw new Error(
    `enrichRuntimeContext: agent enrichment failed after ${MAX_ATTEMPTS} attempts: ${lastReason}`,
  );
}
