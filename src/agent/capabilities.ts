/** Provider-neutral view of a step's capabilities (ENG-476). A step's allowlist
 *  (dispatch/tool-allowlists.ts) is a list of PERMISSION entries — tool names, plus scoped
 *  entries such as `Bash(npm test:*)`. The tool SET a provider must expose is the unique tool
 *  names those entries imply; the scoped patterns still govern what each tool may do. */

/** The exact, sorted, unique tool names a permission list implies. `Bash(<cmd>:*)` → `Bash`. */
export function toolNamesFor(allowedTools: readonly string[]): string[] {
  const names = allowedTools.map((entry) => {
    const scoped = entry.match(/^([A-Za-z][A-Za-z0-9_]*)\(/);
    return scoped ? scoped[1] : entry;
  });
  return [...new Set(names)].sort();
}

/** Null when `effective` is exactly `expected` (order-insensitive); otherwise a human-readable
 *  description of the difference. Any difference is a failure: an extra tool widens the step,
 *  a missing one means the provider did not honor the requested set. */
export function toolSetMismatch(
  expected: readonly string[],
  effective: readonly string[],
): string | null {
  const want = new Set(expected);
  const got = new Set(effective);
  const missing = [...want].filter((t) => !got.has(t)).sort();
  const unexpected = [...got].filter((t) => !want.has(t)).sort();
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing tools: ${missing.join(", ")}`);
  if (unexpected.length > 0) parts.push(`unexpected tools: ${unexpected.join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Why a completed dispatch cannot be accepted as confined, or null when it can (ENG-476). The
 *  report must be present, error-free, carry a tool set, and that set must equal the tools the
 *  step's allowlist implies. Absence is a fault: isolation is verified, never assumed. */
export function capabilityFault(
  allowedTools: readonly string[],
  reported: { tools: string[] | null; error: string | null } | undefined,
): string | null {
  if (reported === undefined) {
    return "the provider did not report the agent's effective tool set";
  }
  if (reported.error !== null) return reported.error;
  if (reported.tools === null) return "the agent's effective tool set is unverifiable";
  return toolSetMismatch(toolNamesFor(allowedTools), reported.tools);
}
