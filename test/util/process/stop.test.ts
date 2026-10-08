// test/util/process/stop.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type ProcInfo, listProcesses, probe } from "../../../src/util/process/proc-table.ts";
import {
  type StopDeps,
  collectTree,
  groupMembers,
  realStopDeps,
  stopGroup,
  stopTree,
} from "../../../src/util/process/stop.ts";

// ---------------------------------------------------------------------------------------------
// A small simulated process world. It lets the stop logic be driven through exact sequences
// (a child that appears mid wait, a wrapper that dies and orphans its child, a process that
// ignores SIGKILL) with a virtual clock, so those tests never depend on real timing.
// ---------------------------------------------------------------------------------------------
type Fate = "die" | "ignore" | "zombie";
interface Spec {
  onTerm?: Fate; // default "die"
  onKill?: "die" | "ignore"; // default "die"
}
const proc = (
  pid: number,
  ppid: number,
  pgid: number,
  startedAt = `100.${String(pid).padStart(6, "0")}`,
  state: ProcInfo["state"] = "running",
): ProcInfo => ({ pid, ppid, pgid, startedAt, state });

class World {
  procs = new Map<number, ProcInfo & Spec>();
  calls: { target: number; sig: string; at: number }[] = [];
  clock = 0;
  events: { at: number; run: () => void; done: boolean }[] = [];
  onSleep?: () => void;
  add(info: ProcInfo, spec: Spec = {}): this {
    this.procs.set(info.pid, { ...info, ...spec });
    return this;
  }
  at(at: number, run: () => void): this {
    this.events.push({ at, run, done: false });
    return this;
  }
  /** Remove a process, as an exit does; its children are re-parented to init. */
  exit(pid: number, asZombie = false): void {
    const p = this.procs.get(pid);
    if (!p) return;
    if (asZombie) p.state = "zombie";
    else this.procs.delete(pid);
    for (const c of this.procs.values()) if (c.ppid === pid) c.ppid = 1;
  }
  signals(sig: string): number[] {
    return this.calls.filter((c) => c.sig === sig).map((c) => c.target);
  }
  private deliver(p: ProcInfo & Spec, sig: string): void {
    if (p.state === "zombie") return;
    if (sig === "SIGTERM") {
      const fate = p.onTerm ?? "die";
      if (fate === "die") this.exit(p.pid);
      else if (fate === "zombie") this.exit(p.pid, true);
    } else if (sig === "SIGKILL") {
      if ((p.onKill ?? "die") === "die") this.exit(p.pid);
    }
  }
  deps: StopDeps = {
    list: () =>
      [...this.procs.values()].map(({ pid, ppid, pgid, startedAt, state }) => ({
        pid,
        ppid,
        pgid,
        startedAt,
        state,
      })),
    kill: (target, sig) => {
      this.calls.push({ target, sig, at: this.clock });
      const victims =
        target > 0
          ? [...this.procs.values()].filter((p) => p.pid === target)
          : [...this.procs.values()].filter((p) => p.pgid === -target);
      for (const v of victims) this.deliver(v, sig);
    },
    sleep: async (ms) => {
      this.clock += ms;
      for (const e of this.events) {
        if (!e.done && e.at <= this.clock) {
          e.done = true;
          e.run();
        }
      }
      this.onSleep?.();
    },
    now: () => this.clock,
  };
}

// ---------------------------------------------------------------------------------------------
// collectTree: the one collection rule (spec 6.1)
// ---------------------------------------------------------------------------------------------
describe("collectTree", () => {
  const ROOT = { pid: 10, startedAt: proc(10, 1, 1).startedAt };

  test("collects the root and its descendants, and nothing unrelated", () => {
    const table = [proc(10, 1, 5), proc(11, 10, 5), proc(12, 11, 5), proc(99, 1, 77)];
    const got = collectTree(ROOT, table, [5])
      .map((p) => p.pid)
      .sort();
    expect(got).toEqual([10, 11, 12]);
  });

  test("a group led by a collected child is taken in, including members that are not descendants", () => {
    // 20 leads group 20 (a tool command group); 21 was started in it but is no longer linked.
    const table = [proc(10, 1, 5), proc(20, 10, 20), proc(21, 1, 20)];
    expect(
      collectTree(ROOT, table, [5])
        .map((p) => p.pid)
        .sort(),
    ).toEqual([10, 20, 21]);
  });

  test("a group the collection did not lead is never taken in (N1)", () => {
    // 31 is a descendant but belongs to group 40, which is led by 40, an unrelated process.
    const table = [proc(10, 1, 5), proc(31, 10, 40), proc(40, 1, 40), proc(41, 1, 40)];
    expect(
      collectTree(ROOT, table, [5])
        .map((p) => p.pid)
        .sort(),
    ).toEqual([10, 31]);
  });

  test("an excluded group is never expanded, even when a collected process leads it (N1)", () => {
    // 50 is a collected child that leads group 50; 60 sits in group 50 but is nobody's descendant.
    const table = [proc(10, 1, 5), proc(50, 10, 50), proc(60, 1, 50)];
    expect(
      collectTree(ROOT, table, [50])
        .map((p) => p.pid)
        .sort(),
    ).toEqual([10, 50]);
    // The same table without the exclusion expands the group: this is what the exclusion prevents.
    expect(
      collectTree(ROOT, table, [])
        .map((p) => p.pid)
        .sort(),
    ).toEqual([10, 50, 60]);
  });

  test("a different process that reuses the root's pid is not the root", () => {
    const table = [proc(10, 1, 5, "999.000000"), proc(11, 10, 5)];
    expect(collectTree(ROOT, table, [5])).toEqual([]);
  });

  test("zombies are collected like any other process; callers decide liveness", () => {
    const table = [proc(10, 1, 5), proc(11, 10, 5, undefined, "zombie")];
    expect(
      collectTree(ROOT, table, [5])
        .map((p) => p.pid)
        .sort(),
    ).toEqual([10, 11]);
  });
});

describe("groupMembers", () => {
  test("lists live members of exactly that group and leaves zombies out", () => {
    const table = [
      proc(20, 1, 20),
      proc(21, 1, 20, undefined, "zombie"),
      proc(22, 1, 20, undefined, "stopped"),
      proc(30, 1, 30),
    ];
    expect(groupMembers(20, table).map((p) => p.pid)).toEqual([20, 22]);
  });
});

// ---------------------------------------------------------------------------------------------
// stopTree on the simulated world
// ---------------------------------------------------------------------------------------------
describe("stopTree (simulated)", () => {
  const ROOT = { pid: 10, startedAt: proc(10, 1, 5).startedAt };
  const OPTS = { graceMs: 1000, excludePgids: [5] };

  test("SIGTERM goes to every collected process at once, before any SIGKILL", async () => {
    const w = new World()
      .add(proc(10, 1, 5), { onTerm: "ignore" }) // a wrapper script that does not die alone
      .add(proc(11, 10, 5), { onTerm: "ignore" })
      .add(proc(12, 11, 5), { onTerm: "ignore" });
    await stopTree(ROOT, "graceful", { ...OPTS, deps: w.deps });
    const sigs = w.calls.map((c) => c.sig);
    expect(w.signals("SIGTERM").sort()).toEqual([10, 11, 12]);
    expect(sigs.lastIndexOf("SIGTERM")).toBeLessThan(sigs.indexOf("SIGKILL"));
  });

  test("a polite stop that works returns without SIGKILL and without waiting out the grace period", async () => {
    const w = new World().add(proc(10, 1, 5)).add(proc(11, 10, 5));
    const rep = await stopTree(ROOT, "graceful", { ...OPTS, graceMs: 5000, deps: w.deps });
    expect(rep.survivors).toEqual([]);
    expect(rep.stopped.map((p) => p.pid).sort()).toEqual([10, 11]);
    expect(w.signals("SIGKILL")).toEqual([]);
    expect(w.clock).toBeLessThan(1000);
  });

  test("a real CLI that drops out of the tree when its wrapper dies is still killed (finding 1)", async () => {
    // wrapper 10 dies on TERM; the CLI 11 ignores TERM and is re-parented to init when 10 exits.
    const w = new World().add(proc(10, 1, 5)).add(proc(11, 10, 5), { onTerm: "ignore" });
    const rep = await stopTree(ROOT, "graceful", { ...OPTS, deps: w.deps });
    expect(w.procs.has(11)).toBe(false);
    expect(w.signals("SIGKILL")).toEqual([11]);
    expect(rep.survivors).toEqual([]);
  });

  test("a child that appears after the polite signal is found by the listing before SIGKILL", async () => {
    // graceMs 0 skips the wait, so only the listing right before SIGKILL can find the new child.
    const w = new World().add(proc(10, 1, 5), { onTerm: "ignore" });
    const origKill = w.deps.kill;
    w.deps.kill = (t, s) => {
      origKill(t, s);
      if (s === "SIGTERM" && !w.procs.has(11)) w.add(proc(11, 10, 5)); // forked while being stopped
    };
    const rep = await stopTree(ROOT, "graceful", { graceMs: 0, excludePgids: [5], deps: w.deps });
    expect(w.signals("SIGKILL").sort()).toEqual([10, 11]);
    expect(w.procs.size).toBe(0);
    expect(rep.survivors).toEqual([]);
  });

  test("a child seen during the wait is still killed after the parent exits and unlinks it", async () => {
    // 10 ignores TERM. At 100 ms child 11 appears (ignores TERM). At 200 ms 10 exits on its own, so
    // 11 is re-parented to init and no longer linked to anything. Only the collection remembers it.
    const w = new World().add(proc(10, 1, 5), { onTerm: "ignore" });
    w.at(100, () => w.add(proc(11, 10, 5), { onTerm: "ignore" }));
    w.at(200, () => w.exit(10));
    const rep = await stopTree(ROOT, "graceful", {
      graceMs: 1000,
      excludePgids: [5],
      deps: w.deps,
    });
    expect(w.signals("SIGKILL")).toContain(11);
    expect(w.procs.size).toBe(0);
    expect(rep.survivors).toEqual([]);
  });

  test("a process that leads a group of its own takes its group members in, and they are signalled by pid", async () => {
    // Claude Code's shape: tool command 20 leads group 20; 21 is a background child left in it.
    const w = new World()
      .add(proc(10, 1, 5))
      .add(proc(20, 10, 20), { onTerm: "ignore" })
      .add(proc(21, 1, 20), { onTerm: "ignore" });
    const rep = await stopTree(ROOT, "graceful", { ...OPTS, deps: w.deps });
    expect(w.signals("SIGTERM").sort()).toEqual([10, 20, 21]);
    expect(rep.survivors).toEqual([]);
    expect(w.calls.every((c) => c.target > 0)).toBe(true); // never a group signal
  });

  test("a group still counts after its leader has exited, if the collection once held the leader", async () => {
    // Tool command 20 leads group 20 and exits at 100 ms. At 150 ms another process (22, linked to
    // nothing) is in that group. The group is found through the leader's remembered pid.
    const w = new World()
      .add(proc(10, 1, 5), { onTerm: "ignore" })
      .add(proc(20, 10, 20), { onTerm: "ignore" });
    w.at(100, () => w.exit(20));
    w.at(150, () => w.add(proc(22, 1, 20)));
    const rep = await stopTree(ROOT, "graceful", {
      graceMs: 1000,
      excludePgids: [5],
      deps: w.deps,
    });
    expect(w.signals("SIGKILL")).toContain(22);
    expect(w.procs.has(22)).toBe(false);
    expect(rep.survivors).toEqual([]);
  });

  test("a different process that reuses a collected pid is not mistaken for it, nor are its children", async () => {
    // 11 is collected, exits, and its pid is reused by an unrelated process that has a child (12).
    const w = new World()
      .add(proc(10, 1, 5), { onTerm: "ignore" })
      .add(proc(11, 10, 5), { onTerm: "ignore" });
    w.at(100, () => {
      w.exit(11);
      w.add(proc(11, 1, 77, "555.000000"), { onTerm: "ignore" });
      w.add(proc(12, 11, 77, "556.000000"), { onTerm: "ignore" });
    });
    await stopTree(ROOT, "graceful", { graceMs: 400, excludePgids: [5], deps: w.deps });
    const touched = new Set(w.calls.map((c) => c.target));
    expect(touched.has(12)).toBe(false);
    expect(w.procs.has(12)).toBe(true);
    expect(w.procs.get(11)?.startedAt).toBe("555.000000");
    expect(w.procs.get(11)?.state).toBe("running");
  });

  test("never signals a group it did not lead, nor an excluded group, nor a bystander (N1)", async () => {
    const w = new World()
      .add(proc(10, 1, 5), { onTerm: "ignore" })
      // a command of the agent that joined group 40, led by an unrelated process 40
      .add(proc(31, 10, 40), { onTerm: "ignore" })
      .add(proc(40, 1, 40))
      .add(proc(41, 1, 40))
      // a collected child that leads an excluded group, with a bystander in it
      .add(proc(50, 10, 50), { onTerm: "ignore" })
      .add(proc(60, 1, 50));
    await stopTree(ROOT, "graceful", { graceMs: 200, excludePgids: [5, 50], deps: w.deps });
    const touched = new Set(w.calls.map((c) => c.target));
    expect(touched.has(40) || touched.has(41) || touched.has(-40)).toBe(false);
    expect(touched.has(60) || touched.has(-50) || touched.has(-5)).toBe(false);
    expect([...touched].sort()).toEqual([10, 31, 50]);
    expect(w.procs.has(40) && w.procs.has(41) && w.procs.has(60)).toBe(true);
  });

  test("a process that becomes a zombie counts as gone: no SIGKILL and no waiting out the grace period", async () => {
    const w = new World().add(proc(10, 1, 5), { onTerm: "zombie" });
    const rep = await stopTree(ROOT, "graceful", { ...OPTS, graceMs: 5000, deps: w.deps });
    expect(rep.survivors).toEqual([]);
    expect(rep.stopped.map((p) => p.pid)).toEqual([10]);
    expect(w.signals("SIGKILL")).toEqual([]);
    expect(w.clock).toBeLessThan(1000);
  });

  test("a zombie root is already gone: nothing is signalled", async () => {
    const w = new World().add(proc(10, 1, 5, undefined, "zombie"));
    const rep = await stopTree(ROOT, "graceful", { ...OPTS, deps: w.deps });
    expect(rep.survivors).toEqual([]);
    expect(w.calls).toEqual([]);
  });

  test("a process that ignores SIGKILL is reported as a survivor, never as stopped, within bounded time", async () => {
    const w = new World()
      .add(proc(10, 1, 5), { onTerm: "ignore", onKill: "ignore" })
      .add(proc(11, 10, 5));
    const rep = await stopTree(ROOT, "graceful", {
      graceMs: 1000,
      excludePgids: [5],
      deps: w.deps,
    });
    expect(rep.survivors.map((p) => p.pid)).toEqual([10]);
    expect(rep.stopped.map((p) => p.pid)).toEqual([11]);
    expect(w.clock).toBeLessThan(1000 + 5000); // grace plus a short confirmation, never unbounded
  });

  test("a forced stop sends no SIGTERM and does not wait", async () => {
    const w = new World().add(proc(10, 1, 5), { onTerm: "ignore" }).add(proc(11, 10, 5));
    const rep = await stopTree(ROOT, "forced", { ...OPTS, graceMs: 5000, deps: w.deps });
    expect(w.signals("SIGTERM")).toEqual([]);
    expect(w.signals("SIGKILL").sort()).toEqual([10, 11]);
    expect(rep.survivors).toEqual([]);
    expect(w.clock).toBe(0);
  });

  test("a second signal (abort.forced) ends the wait early and goes to SIGKILL", async () => {
    const w = new World().add(proc(10, 1, 5), { onTerm: "ignore" });
    const abort = { forced: false };
    w.onSleep = () => {
      abort.forced = true;
    };
    const rep = await stopTree(ROOT, "graceful", {
      graceMs: 5000,
      excludePgids: [5],
      deps: w.deps,
      abort,
    });
    const kill = w.calls.find((c) => c.sig === "SIGKILL");
    expect(kill).toBeDefined();
    expect(kill?.at).toBeLessThan(500);
    expect(rep.survivors).toEqual([]);
  });

  // Latency (spec 11.4): finish() of an agent that already exited reads the table once.
  const counting = (w: World) => {
    let reads = 0;
    const deps: StopDeps = {
      ...w.deps,
      list: () => {
        reads++;
        return w.deps.list();
      },
    };
    return { deps, reads: () => reads };
  };

  test("an agent that already exited, with nothing left in its tree, costs one table read", async () => {
    for (const how of ["graceful", "forced"] as const) {
      // Gone from the table, and a zombie that leads nothing alive.
      for (const w of [
        new World().add(proc(99, 1, 99)),
        new World()
          .add(proc(10, 1, 5, undefined, "zombie"))
          .add(proc(11, 10, 5, undefined, "zombie")),
      ]) {
        const c = counting(w);
        const rep = await stopTree(ROOT, how, { ...OPTS, deps: c.deps });
        expect(c.reads()).toBe(1);
        expect(rep.survivors).toEqual([]);
        expect(rep.signalled).toEqual([]);
        expect(w.calls).toEqual([]);
        expect(w.clock).toBe(0);
      }
    }
  });

  test("a root gone from the table takes nothing in, even rows that still name its pid", async () => {
    // Without the root nothing links to it: not a row whose parent is its pid, not a group whose id
    // is its pid. Both stops leave them alone, after one read.
    for (const how of ["graceful", "forced"] as const) {
      const w = new World()
        .add(proc(11, 10, 11), { onTerm: "ignore" })
        .add(proc(12, 1, 10), { onTerm: "ignore" });
      const c = counting(w);
      const rep = await stopTree(ROOT, how, { ...OPTS, deps: c.deps });
      expect(rep).toEqual({ stopped: [], survivors: [], signalled: [], failures: [] });
      expect(w.calls).toEqual([]);
      expect(c.reads()).toBe(1);
    }
  });

  test("a survivor found by that one read still gets the full stop: SIGTERM, then SIGKILL", async () => {
    // The agent has exited (a zombie not yet reaped); its child, still linked, ignores SIGTERM, and
    // a member of a group the child leads ignores it too.
    const w = new World()
      .add(proc(10, 1, 5, undefined, "zombie"))
      .add(proc(11, 10, 11), { onTerm: "ignore" })
      .add(proc(12, 1, 11), { onTerm: "ignore" });
    const c = counting(w);
    const rep = await stopTree(ROOT, "graceful", { ...OPTS, deps: c.deps });
    expect(w.signals("SIGTERM").sort()).toEqual([11, 12]);
    expect(w.signals("SIGKILL").sort()).toEqual([11, 12]);
    expect(rep.survivors).toEqual([]);
    expect(w.procs.has(11) || w.procs.has(12)).toBe(false);
    expect(c.reads()).toBeGreaterThan(1);
  });

  test("a forced stop of an exited agent whose child survives still kills the child", async () => {
    const w = new World()
      .add(proc(10, 1, 5, undefined, "zombie"))
      .add(proc(11, 10, 5), { onTerm: "ignore" });
    const rep = await stopTree(ROOT, "forced", { ...OPTS, deps: w.deps });
    expect(w.signals("SIGTERM")).toEqual([]);
    expect(w.signals("SIGKILL")).toEqual([11]);
    expect(rep.survivors).toEqual([]);
  });

  test("a root that is already gone, or was replaced under the same pid, signals nothing", async () => {
    const gone = new World();
    expect((await stopTree(ROOT, "graceful", { ...OPTS, deps: gone.deps })).survivors).toEqual([]);
    expect(gone.calls).toEqual([]);
    const reused = new World().add(proc(10, 1, 5, "999.000000"));
    const rep = await stopTree(ROOT, "graceful", { ...OPTS, deps: reused.deps });
    expect(reused.calls).toEqual([]);
    expect(rep.stopped).toEqual([]);
    expect(reused.procs.has(10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// stopGroup on the simulated world
// ---------------------------------------------------------------------------------------------
describe("stopGroup (simulated)", () => {
  test("an empty group returns at once and signals nothing (a normal finish pays nothing)", async () => {
    const w = new World().add(proc(30, 1, 30)); // some other group
    const rep = await stopGroup(20, "graceful", { graceMs: 5000, deps: w.deps });
    expect(rep).toEqual({ stopped: [], survivors: [], signalled: [], failures: [] });
    expect(w.calls).toEqual([]);
    expect(w.clock).toBe(0);
  });

  test("a group holding only zombies is empty", async () => {
    const w = new World().add(proc(20, 1, 20, undefined, "zombie"));
    const rep = await stopGroup(20, "graceful", { graceMs: 5000, deps: w.deps });
    expect(rep).toEqual({ stopped: [], survivors: [], signalled: [], failures: [] });
    expect(w.calls).toEqual([]);
  });

  test("the polite signal goes to the group, and a group that obeys is not killed", async () => {
    const w = new World()
      .add(proc(20, 1, 20))
      .add(proc(21, 20, 20))
      .add(proc(30, 1, 30));
    const rep = await stopGroup(20, "graceful", { graceMs: 5000, deps: w.deps });
    expect(w.calls.map((c) => [c.target, c.sig])).toEqual([[-20, "SIGTERM"]]);
    expect(rep.stopped.map((p) => p.pid).sort()).toEqual([20, 21]);
    expect(rep.survivors).toEqual([]);
    expect(w.procs.has(30)).toBe(true);
  });

  test("a member that ignores SIGTERM is killed by a group SIGKILL", async () => {
    const w = new World().add(proc(20, 1, 20)).add(proc(21, 20, 20), { onTerm: "ignore" });
    const rep = await stopGroup(20, "graceful", { graceMs: 1000, deps: w.deps });
    expect(w.calls.map((c) => [c.target, c.sig])).toEqual([
      [-20, "SIGTERM"],
      [-20, "SIGKILL"],
    ]);
    expect(rep.survivors).toEqual([]);
    expect(rep.stopped.map((p) => p.pid).sort()).toEqual([20, 21]);
  });

  test("a member that ignores SIGKILL is reported as a survivor within bounded time", async () => {
    const w = new World().add(proc(20, 1, 20), { onTerm: "ignore", onKill: "ignore" });
    const rep = await stopGroup(20, "graceful", { graceMs: 1000, deps: w.deps });
    expect(rep.survivors.map((p) => p.pid)).toEqual([20]);
    expect(w.clock).toBeLessThan(1000 + 5000);
  });

  test("a member that becomes a zombie after SIGTERM counts as gone", async () => {
    const w = new World().add(proc(20, 1, 20), { onTerm: "zombie" });
    const rep = await stopGroup(20, "graceful", { graceMs: 5000, deps: w.deps });
    expect(rep.survivors).toEqual([]);
    expect(w.signals("SIGKILL")).toEqual([]);
    expect(w.clock).toBeLessThan(1000);
  });

  test("a forced stop sends SIGKILL to the group and no SIGTERM", async () => {
    const w = new World().add(proc(20, 1, 20), { onTerm: "ignore" });
    const rep = await stopGroup(20, "forced", { graceMs: 5000, deps: w.deps });
    expect(w.calls.map((c) => [c.target, c.sig])).toEqual([[-20, "SIGKILL"]]);
    expect(rep.survivors).toEqual([]);
    expect(rep.stopped.map((p) => p.pid)).toEqual([20]);
  });

  test("a second signal (abort.forced) ends the wait early and goes to SIGKILL", async () => {
    const w = new World().add(proc(20, 1, 20), { onTerm: "ignore" });
    const abort = { forced: false };
    w.onSleep = () => {
      abort.forced = true;
    };
    await stopGroup(20, "graceful", { graceMs: 5000, deps: w.deps, abort });
    const kill = w.calls.find((c) => c.sig === "SIGKILL");
    expect(kill?.at).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------------------------
// Signalling failures are reported, never thrown (review round 1, Important 1 and 2)
// ---------------------------------------------------------------------------------------------
/** Deps whose kill records the call, then throws `code` for targets where `refuse` says so. */
function refusing(
  w: World,
  code: string,
  refuse: (target: number, sig: string) => boolean,
): StopDeps {
  const attempts: { target: number; sig: string }[] = [];
  const deps: StopDeps = {
    ...w.deps,
    kill: (target, sig) => {
      attempts.push({ target, sig });
      if (refuse(target, sig)) throw Object.assign(new Error(`kill ${target}: ${code}`), { code });
      w.deps.kill(target, sig);
    },
  };
  (deps as StopDeps & { attempts: typeof attempts }).attempts = attempts;
  return deps;
}
const attemptsOf = (d: StopDeps) =>
  (d as StopDeps & { attempts: { target: number; sig: string }[] }).attempts;

describe("signalling failures", () => {
  const ROOT = { pid: 10, startedAt: proc(10, 1, 5).startedAt };

  test("stopTree: a process that cannot be signalled (EPERM) does not stop the others being signalled", async () => {
    // tree 10 -> {11, 12}; 11 refuses every signal; 12 ignores TERM and so needs SIGKILL.
    const w = new World()
      .add(proc(10, 1, 5))
      .add(proc(11, 10, 5))
      .add(proc(12, 10, 5), { onTerm: "ignore" });
    const deps = refusing(w, "EPERM", (t) => t === 11);
    const rep = await stopTree(ROOT, "graceful", { graceMs: 400, excludePgids: [5], deps });
    const sent = attemptsOf(deps);
    expect(sent.filter((a) => a.target === 12).map((a) => a.sig)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(sent.filter((a) => a.target === 10).map((a) => a.sig)).toContain("SIGTERM");
    expect(rep.survivors.map((p) => p.pid)).toEqual([11]);
    expect(rep.failures.map((f) => [f.proc.pid, f.code])).toEqual([[11, "EPERM"]]);
    expect(rep.stopped.map((p) => p.pid).sort()).toEqual([10, 12]);
    expect(w.procs.has(12)).toBe(false);
  });

  test("stopTree: a failed signal to a process that then exits is not reported as a failure", async () => {
    const w = new World().add(proc(10, 1, 5), { onTerm: "ignore" });
    w.at(100, () => w.exit(10));
    const deps = refusing(w, "EPERM", () => true);
    const rep = await stopTree(ROOT, "graceful", { graceMs: 1000, excludePgids: [5], deps });
    expect(rep.survivors).toEqual([]);
    expect(rep.failures).toEqual([]);
  });

  test("stopTree: any other error code is reported the same way", async () => {
    const w = new World().add(proc(10, 1, 5));
    const deps = refusing(w, "EINVAL", () => true);
    const rep = await stopTree(ROOT, "forced", { graceMs: 0, excludePgids: [5], deps });
    expect(rep.survivors.map((p) => p.pid)).toEqual([10]);
    expect(rep.failures.map((f) => f.code)).toEqual(["EINVAL"]);
  });

  test("stopGroup: EPERM from a group that died during the stop (macOS) is not an error", async () => {
    // The members exit at 100 ms; the group signal throws EPERM, as macOS does for a group of zombies.
    const w = new World().add(proc(20, 1, 20), { onTerm: "ignore" });
    w.at(100, () => w.exit(20, true));
    const deps = refusing(w, "EPERM", (t) => t < 0);
    const rep = await stopGroup(20, "graceful", { graceMs: 1000, deps });
    expect(rep.survivors).toEqual([]);
    expect(rep.failures).toEqual([]);
  });

  test("stopGroup: EPERM on the final SIGKILL, from a group that has just died, is not an error", async () => {
    // Group members die (zombie) the instant after the last poll; the group kill then throws EPERM.
    const w = new World().add(proc(20, 1, 20), { onTerm: "ignore" });
    const deps = refusing(w, "EPERM", (_t, sig) => {
      if (sig === "SIGKILL") w.exit(20, true);
      return sig === "SIGKILL";
    });
    const rep = await stopGroup(20, "graceful", { graceMs: 100, deps });
    expect(rep.survivors).toEqual([]);
    expect(rep.failures).toEqual([]);
  });

  test("stopGroup: EPERM for a group whose members are alive is a reported failure, and it still escalates", async () => {
    const w = new World().add(proc(20, 1, 20)).add(proc(21, 1, 20));
    const deps = refusing(w, "EPERM", (t) => t < 0);
    const rep = await stopGroup(20, "graceful", { graceMs: 200, deps });
    expect(attemptsOf(deps).map((a) => [a.target, a.sig])).toEqual([
      [-20, "SIGTERM"],
      [-20, "SIGKILL"],
    ]);
    expect(rep.survivors.map((p) => p.pid).sort()).toEqual([20, 21]);
    expect(rep.failures.map((f) => [f.proc.pid, f.code]).sort()).toEqual([
      [20, "EPERM"],
      [21, "EPERM"],
    ]);
  });
});

describe("a target that would signal everyone is refused loudly (Ruling R9a)", () => {
  const OWN = 777;
  const ownWorld = () => new World().add(proc(process.pid, 1, OWN)).add(proc(20, 1, 20));

  test("stopGroup refuses pgid 0, 1 and negative numbers, and sends nothing", async () => {
    for (const bad of [0, 1, -1, -20]) {
      const w = ownWorld();
      await expect(stopGroup(bad, "forced", { graceMs: 0, deps: w.deps })).rejects.toThrow(/pgid/);
      expect(w.calls).toEqual([]);
    }
  });

  test("stopGroup refuses Styre's own group, and sends nothing", async () => {
    const w = ownWorld();
    await expect(stopGroup(OWN, "forced", { graceMs: 0, deps: w.deps })).rejects.toThrow(/own/);
    expect(w.calls).toEqual([]);
    // another group is fine
    expect((await stopGroup(20, "forced", { graceMs: 0, deps: w.deps })).survivors).toEqual([]);
  });

  test("stopGroup with the real deps refuses pgid 1 before reading or signalling anything", async () => {
    const sent: number[] = [];
    await expect(
      stopGroup(1, "graceful", {
        graceMs: 0,
        deps: { ...realStopDeps, kill: (t) => sent.push(t) },
      }),
    ).rejects.toThrow(/pgid/);
    expect(sent).toEqual([]);
  });

  test("stopTree refuses a root that is init, Styre itself, or the leader of Styre's own group", async () => {
    for (const rootPid of [0, 1, process.pid, OWN]) {
      const w = ownWorld().add(proc(OWN, 1, OWN));
      await expect(
        stopTree({ pid: rootPid, startedAt: "x" }, "forced", {
          graceMs: 0,
          excludePgids: [OWN],
          deps: w.deps,
        }),
      ).rejects.toThrow(/root/);
      expect(w.calls).toEqual([]);
    }
  });
});

describe("the group the root itself belongs to is never taken in, whatever the caller passed (Ruling R9b)", () => {
  const ROOT = { pid: 10, startedAt: proc(10, 1, 5).startedAt };
  // 5 is a child of the root and leads group 5, which is the ROOT's own group; 60 is in it too.
  const table = [proc(10, 1, 5), proc(5, 10, 5), proc(60, 1, 5)];

  test("collectTree with no exclusions still leaves the root's own group alone", () => {
    expect(
      collectTree(ROOT, table, [])
        .map((p) => p.pid)
        .sort((a, b) => a - b),
    ).toEqual([5, 10]);
  });

  test("stopTree with no exclusions never signals a bystander in the root's own group", async () => {
    const w = new World();
    for (const t of table) w.add(t, { onTerm: "ignore" });
    await stopTree(ROOT, "graceful", { graceMs: 200, excludePgids: [], deps: w.deps });
    expect(w.calls.map((c) => c.target)).not.toContain(60);
    expect(w.procs.has(60)).toBe(true);
  });

  test("the root's group stays excluded after the root itself has left the table", async () => {
    // Root 10 exits at 100 ms. A new bystander 61 then joins group 5, led by collected child 5.
    const w = new World()
      .add(proc(10, 1, 5), { onTerm: "ignore" })
      .add(proc(5, 10, 5), { onTerm: "ignore" });
    w.at(100, () => w.exit(10));
    w.at(150, () => w.add(proc(61, 1, 5)));
    await stopTree(ROOT, "graceful", { graceMs: 400, excludePgids: [], deps: w.deps });
    expect(w.calls.map((c) => c.target)).not.toContain(61);
    expect(w.procs.has(61)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The real kill function
// ---------------------------------------------------------------------------------------------
describe("realStopDeps.kill", () => {
  test("a process that no longer exists is not an error (ESRCH is swallowed)", async () => {
    const p = Bun.spawn(["sh", "-c", "exit 0"]);
    await p.exited;
    expect(() => realStopDeps.kill(p.pid, "SIGTERM")).not.toThrow();
    expect(() => realStopDeps.kill(-p.pid, "SIGKILL")).not.toThrow();
  });

  test("any other failure is thrown, not hidden", () => {
    expect(() => realStopDeps.kill(process.pid, "SIGNOTREAL" as NodeJS.Signals)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Real processes
// ---------------------------------------------------------------------------------------------
const FX = join(import.meta.dir, "../../lifecycle/fixtures");
const livePids: number[] = [];
const liveGroups: number[] = [];
/** Roots of process trees a test started. Cleanup kills each whole tree (children and the groups
 *  they lead), so a test that fails before it registers the tool command's group leaks nothing. */
const liveRoots: number[] = [];
afterEach(() => {
  // Collect everything first, then kill: killing a parent first would orphan its children out of reach.
  const table = listProcesses();
  const own = table.find((q) => q.pid === process.pid)?.pgid;
  const doomed = new Set<number>();
  for (const pid of [...liveRoots.splice(0), ...livePids]) {
    const r = table.find((q) => q.pid === pid);
    if (!r) continue;
    for (const q of collectTree(r, table, own === undefined ? [] : [own])) doomed.add(q.pid);
  }
  for (const g of liveGroups.splice(0))
    try {
      process.kill(-g, "SIGKILL");
    } catch {}
  for (const pid of [...doomed, ...livePids.splice(0)])
    if (pid !== process.pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
});
const track = <T extends { pid: number }>(p: T): T => {
  livePids.push(p.pid);
  liveRoots.push(p.pid);
  return p;
};
const alive = (pid: number) => {
  const p = probe(pid);
  return p.kind === "alive" && p.info.state !== "zombie";
};
const startOf = (pid: number) => {
  const p = probe(pid);
  if (p.kind !== "alive") throw new Error(`process ${pid} is gone`);
  return p.info.startedAt;
};
const myPgid = () => listProcesses().find((p) => p.pid === process.pid)?.pgid ?? -1;
async function until<T>(what: string, f: () => T | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
/** The tool command of a stand in agent: its child, which must lead a group of its own. Fails with a
 *  plain message when job control is unavailable (a shell that cannot give the job its own group). */
async function toolOf(agentPid: number): Promise<ProcInfo> {
  const child = await until("the stand in agent's tool command to start", () =>
    listProcesses().find((p) => p.ppid === agentPid),
  );
  const leads = await until(
    `the tool command (pid ${child.pid}) to lead a process group of its own: the stand in agent needs bash job control (set -m); a shell that cannot provide it leaves the command in the agent's group`,
    () => listProcesses().find((p) => p.pid === child.pid && p.pgid === p.pid),
    3_000,
  );
  liveGroups.push(leads.pid);
  return leads;
}
let sleepSeed = 400_000 + (process.pid % 1000) * 7;
const uniqueSleep = () => String(++sleepSeed);

describe("stopTree and stopGroup on real processes", () => {
  test("the stand in agent runs its tool command in a group of its own, even with no terminal", async () => {
    const agent = track(
      Bun.spawn([join(FX, "standin-agent.sh")], {
        stdin: "ignore",
        stderr: "ignore",
        env: { ...process.env, STANDIN_SLEEP: uniqueSleep() },
      }),
    );
    const tool = await toolOf(agent.pid);
    expect(tool.pgid).toBe(tool.pid);
    expect(tool.pgid).not.toBe(listProcesses().find((p) => p.pid === agent.pid)?.pgid);
  });

  test("graceful stop: the agent and its tool command in its own group are gone", async () => {
    const agent = track(
      Bun.spawn([join(FX, "standin-agent.sh")], {
        stderr: "ignore",
        env: { ...process.env, STANDIN_SLEEP: uniqueSleep() },
      }),
    );
    const tool = await toolOf(agent.pid);
    const rep = await stopTree({ pid: agent.pid, startedAt: startOf(agent.pid) }, "graceful", {
      graceMs: 5000,
      excludePgids: [myPgid()],
    });
    expect(rep.survivors).toEqual([]);
    expect(alive(agent.pid)).toBe(false);
    expect(alive(tool.pid)).toBe(false);
    expect(rep.stopped.map((p) => p.pid)).toContain(tool.pid);
  });

  test("a stubborn real CLI behind a wrapper that dies is still stopped by force (finding 1)", async () => {
    const w = track(Bun.spawn([join(FX, "wrapper.sh"), join(FX, "stubborn-cli.sh")]));
    const cli = await until("the stubborn CLI", () =>
      listProcesses().find((p) => p.ppid === w.pid),
    );
    livePids.push(cli.pid);
    const rep = await stopTree({ pid: w.pid, startedAt: startOf(w.pid) }, "graceful", {
      graceMs: 500,
      excludePgids: [myPgid()],
    });
    expect(alive(cli.pid)).toBe(false);
    expect(alive(w.pid)).toBe(false);
    expect(rep.survivors).toEqual([]);
  });

  test("Styre's own group is never signalled, even though the agent is in it (N1)", async () => {
    const agent = track(
      Bun.spawn([join(FX, "standin-agent.sh")], {
        stderr: "ignore",
        env: { ...process.env, STANDIN_SLEEP: uniqueSleep() },
      }),
    );
    const bystander = track(Bun.spawn(["sleep", "60"])); // same group as this test process
    await toolOf(agent.pid);
    await stopTree({ pid: agent.pid, startedAt: startOf(agent.pid) }, "graceful", {
      graceMs: 2000,
      excludePgids: [myPgid()],
    });
    expect(alive(bystander.pid)).toBe(true);
    expect(alive(process.pid)).toBe(true);
    expect(alive(agent.pid)).toBe(false);
  });

  test("a process that exits between listing and signalling is not a survivor", async () => {
    const p = track(Bun.spawn(["sh", "-c", "exec sleep 0.05"]));
    const rep = await stopTree({ pid: p.pid, startedAt: startOf(p.pid) }, "graceful", {
      graceMs: 1000,
      excludePgids: [myPgid()],
    });
    expect(rep.survivors).toEqual([]);
  });

  test("a stop that targets a process that is already gone does nothing and reports no survivors", async () => {
    const p = Bun.spawn(["sh", "-c", "exit 0"]);
    const started = startOf(p.pid);
    await p.exited;
    await until("the child to leave the table", () => !alive(p.pid));
    const rep = await stopTree({ pid: p.pid, startedAt: started }, "graceful", {
      graceMs: 1000,
      excludePgids: [myPgid()],
    });
    expect(rep.survivors).toEqual([]);
  });

  test("stopGroup on an already empty group returns at once and signals nothing", async () => {
    const p = Bun.spawn(["sh", "-c", "exit 0"], { detached: true });
    await p.exited;
    const sent: number[] = [];
    const t0 = performance.now();
    const rep = await stopGroup(p.pid, "graceful", {
      graceMs: 20_000,
      deps: { ...realStopDeps, kill: (t) => sent.push(t) },
    });
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(sent).toEqual([]);
    expect(rep).toEqual({ stopped: [], survivors: [], signalled: [], failures: [] });
  });

  test("stopGroup stops a background child a command left in its group", async () => {
    const tag = uniqueSleep();
    const p = Bun.spawn(["sh", "-c", `sleep ${tag} & exit 0`], { detached: true });
    liveGroups.push(p.pid);
    await p.exited;
    const rep = await stopGroup(p.pid, "graceful", { graceMs: 5000 });
    expect(rep.stopped.length).toBeGreaterThan(0);
    expect(rep.survivors).toEqual([]);
    expect(listProcesses().some((q) => q.pgid === p.pid && q.state !== "zombie")).toBe(false);
  });

  test("stopGroup escalates to SIGKILL for a group that ignores SIGTERM", async () => {
    const p = track(Bun.spawn([join(FX, "stubborn-cli.sh")], { detached: true }));
    liveGroups.push(p.pid);
    // Its `sleep 1` child exists only once the line before, the trap, has run.
    await until("the stubborn script's trap to be installed", () =>
      listProcesses().some((q) => q.ppid === p.pid && q.state !== "zombie"),
    );
    const rep = await stopGroup(p.pid, "graceful", { graceMs: 500 });
    expect(rep.survivors).toEqual([]);
    expect(alive(p.pid)).toBe(false);
  });

  /** A real zombie: a child in a group of its own that exited while its parent never waits. */
  async function zombieChild() {
    const parent = track(
      Bun.spawn(["bash", "-c", "set -m; bash -c 'exit 0' & exec sleep 60"], { stdout: "ignore" }),
    );
    const z = await until("a zombie child of the sleeping parent", () =>
      listProcesses().find((q) => q.ppid === parent.pid && q.state === "zombie"),
    );
    return { parent, z };
  }

  test("a real zombie counts as gone for stopTree (kill(pid, 0) would say it is alive)", async () => {
    const { z } = await zombieChild();
    const t0 = performance.now();
    const rep = await stopTree({ pid: z.pid, startedAt: z.startedAt }, "graceful", {
      graceMs: 20_000,
      excludePgids: [myPgid()],
    });
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(rep.survivors).toEqual([]);
  }, 40_000);

  test("a group holding only a real zombie is empty for stopGroup", async () => {
    const { z } = await zombieChild();
    expect(z.pgid).toBe(z.pid); // its own group, which the zombie still holds
    const t0 = performance.now();
    const rep = await stopGroup(z.pgid, "graceful", { graceMs: 20_000 });
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(rep.survivors).toEqual([]);
  }, 40_000);
});

// ---------------------------------------------------------------------------------------------
// `signalled`: exactly the processes a signal was sent to (Task 10's "<n> of its commands" count)
// ---------------------------------------------------------------------------------------------
describe("signalled lists only processes a signal was actually sent to", () => {
  test("stopTree: a zombie in the tree is collected as stopped but was never signalled", async () => {
    const w = new World()
      .add(proc(10, 1, 5))
      .add(proc(11, 10, 5, undefined, "zombie"))
      .add(proc(12, 10, 5));
    const rep = await stopTree({ pid: 10, startedAt: proc(10, 1, 5).startedAt }, "graceful", {
      graceMs: 1000,
      excludePgids: [5],
      deps: w.deps,
    });
    expect(rep.stopped.map((p) => p.pid).sort()).toEqual([10, 11, 12]);
    expect(rep.signalled.map((p) => p.pid).sort()).toEqual([10, 12]);
  });

  test("stopTree: a process whose signal failed is not counted as signalled", async () => {
    const w = new World().add(proc(10, 1, 5)).add(proc(12, 10, 5));
    const deps: StopDeps = {
      ...w.deps,
      kill: (t, s) => {
        if (t === 12) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        w.deps.kill(t, s);
      },
    };
    w.at(10, () => w.exit(12)); // it exits on its own during the wait
    const rep = await stopTree({ pid: 10, startedAt: proc(10, 1, 5).startedAt }, "graceful", {
      graceMs: 1000,
      excludePgids: [5],
      deps,
    });
    expect(rep.survivors).toEqual([]);
    expect(rep.signalled.map((p) => p.pid)).toEqual([10]);
  });

  test("stopGroup: only the live members at the moment of a group signal are signalled", async () => {
    const w = new World()
      .add(proc(20, 1, 20))
      .add(proc(21, 20, 20, undefined, "zombie"))
      .add(proc(22, 20, 20));
    const rep = await stopGroup(20, "graceful", { graceMs: 1000, deps: w.deps });
    expect(rep.survivors).toEqual([]);
    expect(rep.signalled.map((p) => p.pid).sort()).toEqual([20, 22]);
  });

  test("stopGroup: a refused group signal signals nobody", async () => {
    const w = new World().add(proc(20, 1, 20), { onKill: "ignore", onTerm: "ignore" });
    const deps: StopDeps = {
      ...w.deps,
      kill: () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      },
    };
    const rep = await stopGroup(20, "forced", { graceMs: 1000, deps });
    expect(rep.signalled).toEqual([]);
    expect(rep.survivors.map((p) => p.pid)).toEqual([20]);
  });
});
