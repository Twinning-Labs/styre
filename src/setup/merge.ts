import type { RuntimeContext } from "../dispatch/profile.ts";
import type { Enrichment } from "./enrichment-schema.ts";

type Tri = RuntimeContext["data"];

/** present probe wins; otherwise an operator-resolved (non-unknown) existing value survives. */
function mergeTri<T extends { presence: "present" | "absent" | "unknown" }>(
  existing: T,
  probed: T,
): T {
  if (probed.presence === "present") return probed;
  if (existing.presence !== "unknown") return existing;
  return probed;
}

export function mergeRuntimeContext(
  existing: RuntimeContext,
  probed: RuntimeContext,
): RuntimeContext {
  return {
    topology:
      probed.topology.type !== "unknown" || existing.topology.type === "unknown"
        ? probed.topology
        : existing.topology,
    data: mergeTri(existing.data as Tri, probed.data as Tri) as RuntimeContext["data"],
    caching: mergeTri(existing.caching, probed.caching),
    observability: mergeTri(existing.observability, probed.observability),
    configSecrets: mergeTri(existing.configSecrets, probed.configSecrets),
    documentation: mergeTri(existing.documentation, probed.documentation),
    releasePackaging:
      probed.releasePackaging.mechanism !== "unknown" ||
      existing.releasePackaging.mechanism === "unknown"
        ? probed.releasePackaging
        : existing.releasePackaging,
  };
}

type Presence = "present" | "absent" | "unknown";

const pickDetail = (agent: string, scan: string): string => (agent.trim() !== "" ? agent : scan);

// scan flag wins unless it's unknown, then the agent's proposal (if any), else unknown.
const mergePresence = (scan: Presence, agent?: Presence): Presence =>
  scan !== "unknown" ? scan : (agent ?? "unknown");

/** Layer 1+2 of the probe: the deterministic scan is ground truth for flags; the agent
 *  enriches detail everywhere and resolves only sections the scan left `unknown`. */
export function mergeScanAndEnrichment(scan: RuntimeContext, enr: Enrichment): RuntimeContext {
  const migrationTool = scan.data.migrationTool ?? enr.data.migrationTool;
  return {
    topology: {
      type:
        scan.topology.type !== "unknown" ? scan.topology.type : (enr.topology.type ?? "unknown"),
      detail: pickDetail(enr.topology.detail, scan.topology.detail),
    },
    data: {
      presence: mergePresence(scan.data.presence, enr.data.presence),
      detail: pickDetail(enr.data.detail, scan.data.detail),
      ...(migrationTool ? { migrationTool } : {}),
    },
    caching: {
      presence: mergePresence(scan.caching.presence, enr.caching.presence),
      detail: pickDetail(enr.caching.detail, scan.caching.detail),
    },
    observability: {
      presence: mergePresence(scan.observability.presence, enr.observability.presence),
      detail: pickDetail(enr.observability.detail, scan.observability.detail),
    },
    configSecrets: {
      presence: mergePresence(scan.configSecrets.presence, enr.configSecrets.presence),
      detail: pickDetail(enr.configSecrets.detail, scan.configSecrets.detail),
    },
    documentation: {
      presence: mergePresence(scan.documentation.presence, enr.documentation.presence),
      detail: pickDetail(enr.documentation.detail, scan.documentation.detail),
    },
    releasePackaging: {
      mechanism:
        scan.releasePackaging.mechanism !== "unknown"
          ? scan.releasePackaging.mechanism
          : (enr.releasePackaging.mechanism ?? "unknown"),
      detail: pickDetail(enr.releasePackaging.detail, scan.releasePackaging.detail),
    },
  };
}
