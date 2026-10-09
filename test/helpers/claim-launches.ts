// Claiming what Styre's own code launched (test/helpers/own-processes.ts): a test that drives an
// adapter or a command runner never holds the launch handle itself, and what the launch starts
// (an agent's tool command, a child of a fake CLI) appears only later. The latest moment it is surely
// still this test's descendant is when a stop reads the process table, just before it signals
// anything: if the stop then fails to end it (a regression), it is already claimed, so afterEach
// kills it by recorded identity and the end of run leak check sees it.
import * as door from "../../src/util/process/door.ts";
import { listProcesses } from "../../src/util/process/proc-table.ts";
import { type StopDeps, realStopDeps } from "../../src/util/process/stop.ts";
import { ownLaunch } from "./own-processes.ts";

/** Claim the tree of every live launch (and register a command's group), in one fresh read of the
 *  real process table. */
export function claimLiveLaunches(): void {
  const table = listProcesses();
  for (const h of door.liveLaunches()) ownLaunch(h, table);
}

/** `base` (the real stop functions by default), whose every table listing first claims what the
 *  live launches are running. The claim reads the real table on its own, so a `base.list` that adds
 *  made-up rows never feeds them to the claim. */
export function claimingStopDeps(base: StopDeps = realStopDeps): StopDeps {
  return {
    ...base,
    list: () => {
      claimLiveLaunches();
      return base.list();
    },
  };
}

/** Install `claimingStopDeps()` as the door's stop functions (door.__resetForTests removes them). */
export function claimLaunchesAtStops(): void {
  door.__setStopDepsForTests(claimingStopDeps());
}
