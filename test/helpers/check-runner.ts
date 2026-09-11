import type { CmdRunner } from "../../src/dispatch/reuse.ts";
import type { CommandResult } from "../../src/util/run-command.ts";

const OK: CommandResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false };

/**
 * ENG-426: `checks:dispatch` now makes TWO kinds of call through `runCheckCommand` — the
 * capability probe (can this framework run at all?) and the RED-first check itself. A fake that
 * answers both with one fixed result is no longer a faithful stand-in for the real runner: in
 * production a `--version` call succeeds while the check under test fails, and a fake that fails
 * both makes every run look like an environment with no test framework.
 *
 * `scriptedCheckRunner` keeps the probe honest (it succeeds, as it does on a machine that has the
 * framework) and hands everything else to `scripted`. Pass `probeFails: true` to simulate the
 * django case — a framework that is simply not installed.
 */
export function scriptedCheckRunner(
  scripted: (command: string, opts: { cwd: string; timeoutMs: number }) => Promise<CommandResult>,
  opts: { probeFails?: boolean } = {},
): CmdRunner {
  return async (command, runOpts) => {
    if (isCapabilityProbe(command)) {
      return opts.probeFails
        ? { exitCode: 1, stdout: "", stderr: "No module named pytest", timedOut: false }
        : OK;
    }
    return scripted(command, runOpts);
  };
}

/** Mirrors `capabilityCommandFor` (src/dispatch/check-capability.ts) — all three probe shapes it
 *  emits, including the two overrides. Kept as a predicate rather than a string compare because
 *  the launcher varies per component and a test fake does not know it.
 *
 *  A fake that answers the probe OK while failing the check is not artificial: it is darkreader's
 *  ENG-399 shape exactly — `npm run test:ci --` answers, while the bare `jest` inside it is not
 *  found. A launcher that is absent ENTIRELY fails both, which is what `probeFails` simulates. */
function isCapabilityProbe(command: string): boolean {
  return (
    / --version$/.test(command) ||
    command === "go version" ||
    command.includes("require 'minitest/autorun'")
  );
}
