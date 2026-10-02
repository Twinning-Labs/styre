import { afterEach } from "bun:test";
import * as door from "../../src/util/process/door.ts";
import { realStopDeps } from "../../src/util/process/stop.ts";

/**
 * A stop that really signals and really inspects the process table, but whose clock is virtual: each
 * `sleep` advances it by `stepMs` after a short real pause, so the 5 second grace of a graceful stop
 * (ENG-485 D8) passes in a fraction of a second. Every signal is recorded with the virtual time it
 * was sent at, so a test can assert the order and the gap, not just the final state.
 */
export interface GracefulStopRecorder {
  sent: { sig: NodeJS.Signals; at: number }[];
  /** Virtual milliseconds since the recorder was created. */
  elapsed: () => number;
}

export function installVirtualGrace(stepMs = 250): GracefulStopRecorder {
  let virtual = 0;
  const sent: GracefulStopRecorder["sent"] = [];
  door.__setStopDepsForTests({
    ...realStopDeps,
    kill: (target, sig) => {
      sent.push({ sig, at: virtual });
      realStopDeps.kill(target, sig);
    },
    sleep: async () => {
      await Bun.sleep(10); // a real pause, so a killed process is really gone before the next look
      virtual += stepMs;
    },
    now: () => virtual,
  });
  return { sent, elapsed: () => virtual };
}

/** Restore the real stop after each test, and stop anything the test left behind. */
export function resetDoorAfterEach(): void {
  afterEach(() => door.__resetForTests());
}
