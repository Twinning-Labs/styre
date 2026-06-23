import type { RuntimeContext } from "../dispatch/profile.ts";

type Tri = RuntimeContext["data"];

/** present probe wins; otherwise an operator-resolved (non-unknown) existing value survives. */
function mergeTri<T extends { presence: "present" | "absent" | "unknown" }>(existing: T, probed: T): T {
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
