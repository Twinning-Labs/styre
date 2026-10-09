import { removeCommandTempDir } from "../util/process/command-temp.ts";
import { describeProcess, isStopping, liveLaunches } from "../util/process/door.ts";
import { pendingLeftoverChecks } from "../util/process/leftovers.ts";
import { reportSurvivors } from "../util/run-command.ts";
import { EXIT } from "./errors.ts";
import { guard } from "./output.ts";

/**
 * The check at the end of `styre run` and `styre setup` (ENG-485 section 7.7). It first waits for
 * the leftover checks still running in the background, each bounded by its own timeout (a check
 * that timed out has said so and is not a leak). It then asserts that the set of launches held in
 * memory is empty, apart from launches an earlier stop could not end: those keep their records, and
 * their survivors were named by that stop's caller, so they are neither stopped nor reported again.
 * Any other launch still there is a bug: Styre stops it, says what it stopped, and makes
 * the exit status EXIT.INTERNAL, so a leak is never silent. It never replaces a status that already
 * says something (75 paused, 65, 64, 1, or any error's own code): it only turns success into 70.
 * While a stop is in progress it does nothing: the launches still live are the stop handler's, which
 * is stopping them and owns the exit (section 7.3).
 */
export async function assertNoLeakedLaunches(): Promise<void> {
  if (isStopping()) return;
  await pendingLeftoverChecks();
  const leaked = liveLaunches().filter((h) => !h.leftSurvivors);
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
 *  stopped and named either way, and the error boundary's exit code stands. Then the commands' temp
 *  folder goes (command-temp.ts), unless a stop is in progress: the stop handler owns that. `after`
 *  runs last, once the check is done, whatever happened: `styre run` and `styre setup` remove their
 *  stop handlers there, so a signal during the check's wait for leftover checks is still handled
 *  (R27). */
export async function guardWithExitCheck(
  cmd: string,
  body: () => Promise<void>,
  after?: () => void,
): Promise<void> {
  try {
    await guard(cmd, body);
    await assertNoLeakedLaunches();
    if (!isStopping()) {
      removeCommandTempDir((s) => {
        try {
          process.stderr.write(s);
        } catch {
          /* a closed stderr must not fail the exit */
        }
      });
    }
  } finally {
    after?.();
  }
}
