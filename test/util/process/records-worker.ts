// Helper for records.test.ts: a second thread that hammers the record folder, so the tests can
// check the properties that only break under a real interleaving. Not a test file.
import { workerData } from "node:worker_threads";
import { claim, listRecords, unclaim } from "../../../src/util/process/records.ts";

const { mode, sab, dwellMicros } = workerData as {
  mode: "flip" | "read";
  sab: SharedArrayBuffer;
  dwellMicros: number;
};
// flag[0] = stop request; flag[1] = worker is running; flag[2] = parent has finished its first write;
// flag[3] = number of times a reader found the folder empty after the first write.
const flag = new Int32Array(sab);
Atomics.store(flag, 1, 1);
// A real sweep holds a claim for the length of an identity check, far longer than a rename, so the
// worker dwells in each state for a moment. Flipping faster than any reader can act on a name would
// starve every deleter by construction, and that is not the case the tests are about.
function dwell(micros: number): void {
  const until = performance.now() + micros / 1000;
  while (performance.now() < until) {
    /* spin */
  }
}

let held: ReturnType<typeof listRecords>[number] | null = null;
while (Atomics.load(flag, 0) === 0) {
  if (mode === "flip") {
    // Flip the record between its two names as fast as possible; look the record up again only when
    // the owner has removed it. Holding the last listing keeps the window between flips tiny.
    if (held === null) held = listRecords()[0] ?? null;
    if (held === null) continue;
    const c = claim(held, { pid: 9, startedAt: "9.000000" });
    if (c === null) {
      held = null;
      continue;
    }
    dwell(dwellMicros * (0.5 + Math.random()));
    unclaim(c);
    dwell(dwellMicros * (0.5 + Math.random()));
    held = { ...held, file: held.file.replace(/\.claimed-.*$/, ""), claimedBy: null };
  } else if (Atomics.load(flag, 2) === 1 && listRecords().length === 0) {
    Atomics.add(flag, 3, 1);
  }
}
