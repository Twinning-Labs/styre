import type { ZodType } from "zod";

export type SidecarResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "absent" | "malformed"; detail: string };

/** Extract + zod-validate an agent's structured-output sidecar block (control-loop §3a).
 *  A fenced ```<fence> ... ``` block holds JSON. Absent fence vs malformed JSON/shape are
 *  distinguished: both are transport failures (M3b re-dispatches), never a real verdict. */
export function extractSidecar<T>(
  output: string,
  schema: ZodType<T>,
  opts?: { fence?: string },
): SidecarResult<T> {
  const fence = opts?.fence ?? "styre-sidecar";
  const re = new RegExp(`\`\`\`${fence}\\s*\\n([\\s\\S]*?)\\n\`\`\``, "g");
  const matches = [...output.matchAll(re)];
  const lastMatch = matches[matches.length - 1];
  if (!lastMatch || lastMatch[1] === undefined) {
    return { ok: false, reason: "absent", detail: `no \`\`\`${fence} block found` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastMatch[1]);
  } catch (err) {
    return { ok: false, reason: "malformed", detail: `invalid JSON: ${String(err)}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "malformed", detail: result.error.message };
  }
  return { ok: true, value: result.data };
}
