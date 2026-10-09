// ENG-485 section 5.3 and section 8, hardened after the final review (A F6, C M2). The records
// folder is trusted only when it is a real folder owned by this user that no one else can write; a
// record file only when it is a regular file of this user's, no larger than 64 KB, opened without
// following a symbolic link. The temporary file a record is written through is never written
// through a symbolic link. A claim that fails for any reason but "the file is gone" is said.
//
// Every process here is this test's own, claimed through test/helpers/own-processes.ts at start and
// stopped in afterEach. With the code correct, nothing here is signalled by the sweep.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as door from "../../../src/util/process/door.ts";
import { bootId, probe } from "../../../src/util/process/proc-table.ts";
import {
  type LaunchRecord,
  claim,
  processesDir,
  recordFileName,
  scanRecords,
  writeRecord,
} from "../../../src/util/process/records.ts";
import { sweepOrphans } from "../../../src/util/process/sweep.ts";
import { isAlive, killOwned, own } from "../../helpers/own-processes.ts";
import { makeTempDir } from "../../helpers/temp.ts";

let state: string;
const saved = process.env.XDG_STATE_HOME;
beforeEach(() => {
  state = makeTempDir("styre-rec-hard-");
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  killOwned();
  process.env.XDG_STATE_HOME = saved;
  try {
    chmodSync(processesDir(), 0o700);
  } catch {
    /* no folder */
  }
  rmSync(state, { recursive: true, force: true });
});

const startOf = (pid: number) => {
  const p = probe(pid);
  if (p.kind !== "alive") throw new Error(`pid ${pid} is ${p.kind}`);
  return p.info;
};

/** A sleep of this test's own, claimed at once; it ends by itself after 23.6 s whatever happens. */
function victim() {
  const p = Bun.spawn(["sleep", "23.6119"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const info = startOf(p.pid);
  own(info);
  return info;
}

function planted(p: { pid: number; startedAt: string }): LaunchRecord {
  return {
    version: 1,
    pid: p.pid,
    startedAt: p.startedAt,
    bootId: bootId(),
    kind: "agent",
    ident: "PLANTED",
    stepId: null,
    worktree: null,
    command: "planted",
    // An owner that cannot be alive: pid 999999 does not exist on macOS (pids end at 99999).
    owner: { pid: 999999, startedAt: "1.000000", pgid: 999999 },
  };
}

function plant(r: LaunchRecord, mode = 0o600): string {
  const dir = processesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, recordFileName(r));
  writeFileSync(path, JSON.stringify(r), { mode });
  return path;
}

test("reviewer A's probe P5: a records folder others may write is refused in one line, and its planted record stops nothing", async () => {
  const v = victim();
  plant(planted(v));
  chmodSync(processesDir(), 0o777);
  const lines: string[] = [];
  const r = await sweepOrphans({ stderr: (s) => lines.push(s) });
  await Bun.sleep(300);
  expect(isAlive(v)).toBe(true);
  expect(r.stopped).toEqual([]);
  expect(lines).toEqual([
    `styre: ignored the launch records folder ${processesDir()}: it is writable by group or others (mode 777), so no orphans were stopped; make it a folder only you can write (chmod 700 ${processesDir()})\n`,
  ]);
  // The planted record is left as it was.
  expect(readdirSync(processesDir())).toEqual([recordFileName(planted(v))]);
});

test("a records folder that is a symbolic link is refused", async () => {
  const v = victim();
  const real = join(state, "elsewhere");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, processesDir());
  writeFileSync(join(real, recordFileName(planted(v))), JSON.stringify(planted(v)));
  const lines: string[] = [];
  await sweepOrphans({ stderr: (s) => lines.push(s) });
  expect(isAlive(v)).toBe(true);
  expect(lines).toEqual([
    `styre: ignored the launch records folder ${processesDir()}: it is a symbolic link, so no orphans were stopped; make it a folder only you can write (chmod 700 ${processesDir()})\n`,
  ]);
});

test("a record larger than 64 KB is said and left in place, never read whole", () => {
  const dir = processesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const big = join(dir, "4321-1.000000.json");
  writeFileSync(big, Buffer.alloc(65 * 1024 + 1, 0x20));
  const scan = scanRecords();
  expect(scan.listed).toEqual([]);
  expect(scan.unreadable).toEqual([
    { file: "4321-1.000000.json", reason: "it is larger than 64 KB" },
  ]);
  expect(existsSync(big)).toBe(true);
});

test.skipIf(process.getuid?.() !== 0)(
  "a record file owned by another user is said and left in place (run as root)",
  () => {
    const v = { pid: 4321, startedAt: "1.000000" };
    const path = plant(planted(v));
    chownSync(path, 4242, 4242);
    const scan = scanRecords();
    expect(scan.listed).toEqual([]);
    expect(scan.unreadable).toEqual([
      { file: recordFileName(v), reason: "it is owned by uid 4242, not by you (uid 0)" },
    ]);
  },
);

test("the temporary file a record is written through is never written through a symbolic link", () => {
  const dir = processesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(state, "target");
  writeFileSync(target, "untouched");
  const r = planted({ pid: 4321, startedAt: "1.000000" });
  symlinkSync(target, join(dir, `.${recordFileName(r)}.tmp-${process.pid}`));
  expect(() => writeRecord(r)).toThrow();
  expect(readFileSync(target, "utf8")).toBe("untouched");
});

test.skipIf(process.getuid?.() === 0)(
  "a claim that fails for a reason other than a missing file is not silent",
  () => {
    const r = planted({ pid: 4321, startedAt: "1.000000" });
    plant(r);
    const [l] = scanRecords().listed;
    chmodSync(processesDir(), 0o500); // the rename cannot happen: EACCES
    try {
      expect(() => claim(l, { pid: process.pid, startedAt: "2.000000" })).toThrow(/EACCES|EPERM/);
    } finally {
      chmodSync(processesDir(), 0o700);
    }
  },
);

test("a claim of a record that is gone is null, as before", () => {
  const r = planted({ pid: 4321, startedAt: "1.000000" });
  const path = plant(r);
  const [l] = scanRecords().listed;
  rmSync(path);
  expect(claim(l, { pid: process.pid, startedAt: "2.000000" })).toBeNull();
});

test.skipIf(process.getuid?.() === 0)(
  "a sweep that cannot put a claimed record back says so and goes on",
  async () => {
    // A live owner: the sweep claims the record, finds the owner alive, and puts it back. The folder
    // turns read only between the claim and the put back.
    const me = startOf(process.pid);
    const r = { ...planted({ pid: 4321, startedAt: "1.000000" }), owner: me };
    plant(r);
    const lines: string[] = [];
    let flipped = false;
    const res = await sweepOrphans({
      stderr: (s) => lines.push(s),
      afterClaim: () => {
        if (!flipped) chmodSync(processesDir(), 0o500);
        flipped = true;
      },
    });
    chmodSync(processesDir(), 0o700);
    expect(res.stopped).toEqual([]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(
      /^styre: could not put back the launch record for pid 4321 from PLANTED: .*(EACCES|EPERM).*\n$/,
    );
  },
);
