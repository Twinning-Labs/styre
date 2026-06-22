import type { CheckVerdict, ChecksPort } from "../checks.ts";

/** In-memory recording ChecksPort for tests (the fakeForge analogue). Returns a fixed verdict. */
export function fakeChecks(
  verdict: CheckVerdict = "passing",
): ChecksPort & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    async status(opts: { ref: string }): Promise<CheckVerdict> {
      calls.push({ method: "status", args: [opts] });
      return verdict;
    },
  };
}
