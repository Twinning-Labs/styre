/** Vendor-neutral checks-system port (zero lock-in). The core depends only on this interface;
 *  GitHub checks / GitLab pipelines / etc. are config-selected adapters behind it. Mirrors
 *  src/integrations/forge.ts. Selection is keyed on the PROBED profile.checksSystem (product
 *  shape), not RuntimeConfig — see docs/architecture (config layering). */
export type CheckVerdict = "passing" | "failing" | "pending";

export interface ChecksPort {
  /** Aggregate the checks state for a commit `ref` (sha): all green → "passing"; any
   *  terminal failure → "failing"; still running / not yet reported → "pending". */
  status(opts: { ref: string }): Promise<CheckVerdict>;
}

export type ChecksFactory = () => ChecksPort;

/** Build the checks port for a project's probed checks system, or null when there is no
 *  pollable system (e.g. "none" → human merge is the gate; "external" → no adapter yet). */
export function selectChecks(
  checksSystem: string,
  adapters: Record<string, ChecksFactory>,
): ChecksPort | null {
  const factory = adapters[checksSystem];
  return factory ? factory() : null;
}
