import { describeProcess, liveLaunches } from "../util/process/door.ts";
import { pendingLeftoverChecks } from "../util/process/leftovers.ts";
import { reportSurvivors } from "../util/run-command.ts";
import { EXIT } from "./errors.ts";
import { guard } from "./output.ts";

/**
 * The check at the end of `styre run` and `styre setup` (ENG-485 section 7.7). It first waits for
 * the leftover checks still running in the background, each bounded by its own timeout (a check
 * that timed out has said so and is not a leak). It then asserts that the set of launches held in
 * memory is empty. A launch still there is a bug: Styre stops it, says what it stopped, and makes
 * the exit status EXIT.INTERNAL, so a leak is never silent. It never replaces a status that already
 * says something (75 paused, 65, 64, 1, or any error's own code): it only turns success into 70.
 */
export async function assertNoLeakedLaunches(): Promise<void> {
  await pendingLeftoverChecks();
  const leaked = liveLaunches();
  if (leaked.length === 0) return;
  for (const h of leaked) {
    const command = describeProcess(h.record.pid, h.record.command);
    const report = await h.stop("graceful");
    process.stderr.write(
      `styre: internal error: a launch was still running at exit; stopped "${command}" (pid ${h.record.pid}).\n`,
    );
    reportSurvivors(h, report.survivors);
  }
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = EXIT.INTERNAL;
}

/** `guard`, plus the exit check. The check also runs when the command threw: a leaked launch is
 *  stopped and named either way, and the error boundary's exit code stands. */
export async function guardWithExitCheck(cmd: string, body: () => Promise<void>): Promise<void> {
  await guard(cmd, body);
  await assertNoLeakedLaunches();
}
