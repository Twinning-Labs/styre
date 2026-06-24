import type { FailureCause } from "../agent/runner.ts";

/** A resumable-park request (ENG-164). Carries everything needed to record the park and to
 *  resume the interrupted step later. Distinct from a normal Error so the journal can leave the
 *  step 'running' (recover() owns it) instead of marking it failed and burning a retry attempt. */
export interface ParkInfo {
  cause: Exclude<FailureCause, "transient">; // "session-limit" | "out-of-credits"
  resetAt: string | null;
  dispatchId: string;
  transcript: string;
}

export class ParkSignal extends Error {
  constructor(readonly info: ParkInfo) {
    super(`dispatch ${info.dispatchId} parked: ${info.cause}`);
    this.name = "ParkSignal";
  }
}
