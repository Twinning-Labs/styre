import type { LaunchHandle } from "../util/process/door.ts";
import type { StopReport } from "../util/process/stop.ts";
import { reportSurvivors } from "../util/run-command.ts";

/** What a stop reports when it threw before it could count anything. */
export const emptyStop: StopReport = { stopped: [], survivors: [], failures: [] };

/** A stop that left processes alive is never hidden (ENG-485 section 9.4): say so on Styre's
 *  stderr, with the line the operator can act on. Shared by every agent adapter. */
export function reportStop(h: LaunchHandle, rep: StopReport): void {
  if (rep.survivors.length > 0) reportSurvivors(h, rep.survivors);
}
