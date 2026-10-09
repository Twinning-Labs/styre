// ENG-485 section 5.3 (final review A F9(b)): once a launch has been released (everything confirmed
// gone, its record removed, its handle out of the live set), its pid may be handed to another
// program, even as a new group id. A later stop() or finish() on that handle must do nothing: no
// table read, no signal.
//
// Safety: the stop functions here are stand-ins that count calls and refuse every signal, so this
// test sends no real signal. The command (`true`) ends by itself.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as door from "../../../src/util/process/door.ts";
import { type ProcInfo, listProcesses } from "../../../src/util/process/proc-table.ts";
import { realStopDeps } from "../../../src/util/process/stop.ts";
import { until } from "../../helpers/own-processes.ts";

let state: string;
const saved = process.env.XDG_STATE_HOME;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "styre-released-"));
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  door.__resetForTests();
  process.env.XDG_STATE_HOME = saved;
  rmSync(state, { recursive: true, force: true });
});

for (const kind of ["group", "agent"] as const) {
  test(`a released ${kind} launch's stop and finish do nothing`, async () => {
    const h = door.launch({
      argv: ["true"],
      cwd: state,
      env: { ...process.env },
      kind,
      context: { ident: null, stepId: null, worktree: null },
    });
    expect(await until(() => h.proc.exitCode !== null)).toBe(true);
    const first = await h.finish();
    expect(first.survivors).toEqual([]);
    expect(door.liveLaunches()).toEqual([]);

    // From here the pid stands for nothing of Styre's: make the table say a new process holds it,
    // leading a group, as a reused pid would.
    let lists = 0;
    let probes = 0;
    const kills: number[] = [];
    const reused: ProcInfo = {
      pid: h.record.pid,
      ppid: 1,
      pgid: h.record.pid,
      startedAt: h.record.startedAt, // even the same start time: released means released
      state: "running",
    };
    door.__setStopDepsForTests({
      ...realStopDeps,
      list: () => {
        lists++;
        return [...listProcesses(), reused];
      },
      probe: () => {
        probes++;
        return { kind: "alive", info: reused };
      },
      kill: (target) => {
        kills.push(target);
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    });
    const empty = { stopped: [], survivors: [], signalled: [], failures: [] };
    expect(await h.stop("forced")).toEqual(empty);
    expect(await h.stop("graceful")).toEqual(empty);
    expect(await h.finish()).toEqual(empty);
    expect({ lists, probes, kills }).toEqual({ lists: 0, probes: 0, kills: [] });
  });
}
