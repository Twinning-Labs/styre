// The sweep's second job: removing the temp folder a Styre that was force quit gave its commands.
// Each Styre that starts a project command notes its temp folder in the launch records folder
// (tmp-<pid>-<start>.json) and removes both on its way out. A note left behind names a Styre that
// never got there. The sweep removes the folder only once that Styre is gone and nothing of its is
// still recorded, and only a folder that is exactly what the note says it is. Each test gets its own
// state folder and temp root; the processes it starts are its own and are killed in afterEach.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as door from "../../src/util/process/door.ts";
import * as procTable from "../../src/util/process/proc-table.ts";
import { bootId, probe } from "../../src/util/process/proc-table.ts";
import { type LaunchRecord, processesDir, writeRecord } from "../../src/util/process/records.ts";
import * as records from "../../src/util/process/records.ts";
import { sweepOrphans } from "../../src/util/process/sweep.ts";
import { killOwned, ownChild, until } from "../helpers/own-processes.ts";
import { makeTempDir } from "../helpers/temp.ts";

let state: string;
let root: string;
const saved = process.env.XDG_STATE_HOME;

beforeEach(() => {
  state = makeTempDir("styre-sweep-temp-state-");
  process.env.XDG_STATE_HOME = state;
  root = realpathSync(makeTempDir("styre-sweep-temp-root-"));
  door.__resetForTests();
});
afterEach(() => {
  killOwned();
  process.env.XDG_STATE_HOME = saved;
  rmSync(state, { recursive: true, force: true });
});

interface Who {
  pid: number;
  startedAt: string;
}
const startOf = (pid: number): procTable.ProcInfo => {
  const p = probe(pid);
  if (p.kind !== "alive") throw new Error(`pid ${pid} is ${p.kind}`);
  return p.info;
};
/** A fake "dead Styre": a short lived process whose identity a note then names. */
async function deadOwner(): Promise<Who> {
  const p = Bun.spawn(["sleep", "0.2"]);
  const info = startOf(p.pid);
  await p.exited;
  expect(
    await until(() => {
      const q = probe(info.pid);
      return q.kind === "gone" || (q.kind === "alive" && q.info.state === "zombie");
    }),
  ).toBe(true);
  return { pid: info.pid, startedAt: info.startedAt };
}
/** The folder a Styre with this identity would have made, holding what a stopped command left. */
function folderOf(_owner: Who, suffix = "Ab3xY9"): string {
  const dir = join(root, `styre-cmd-${suffix}`);
  mkdirSync(join(dir, "karma-12345678"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "karma-12345678", "prefs.js"), "");
  return dir;
}
const noteName = (owner: Who) => `tmp-${owner.pid}-${owner.startedAt}.json`;
function writeNote(owner: Who, path: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(processesDir(), { recursive: true, mode: 0o700 });
  const file = join(processesDir(), noteName(owner));
  writeFileSync(file, JSON.stringify({ version: 1, owner, bootId: bootId(), path, ...extra }), {
    mode: 0o600,
  });
  return file;
}
const collect = () => {
  const lines: string[] = [];
  return { lines, stderr: (s: string) => lines.push(s) };
};

test("a force quit Styre's temp folder is removed with what it held, and its note too, silently", async () => {
  const owner = await deadOwner();
  const dir = folderOf(owner);
  const note = writeNote(owner, dir);
  const out = collect();
  const r = await sweepOrphans({ stderr: out.stderr });
  expect(r.tempFolders).toEqual([dir]);
  expect(out.lines).toEqual([]);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(note)).toBe(false);
});

test("a note whose folder is already gone is removed", async () => {
  const owner = await deadOwner();
  const note = writeNote(owner, join(root, "styre-cmd-Zz0000"));
  const out = collect();
  const r = await sweepOrphans({ stderr: out.stderr });
  expect(r.tempFolders).toEqual([]);
  expect(out.lines).toEqual([]);
  expect(existsSync(note)).toBe(false);
});

test("a live Styre's folder is kept: this process, and another live process", async () => {
  const me = startOf(process.pid);
  const mine = folderOf(me);
  writeNote(me, mine);
  const other = Bun.spawn(["sleep", "4211"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  ownChild(other);
  const peer = startOf(other.pid);
  const theirs = folderOf(peer, "Peer00");
  writeNote(peer, theirs);
  const r = await sweepOrphans({ stderr: () => {} });
  expect(r.tempFolders).toEqual([]);
  expect(existsSync(mine)).toBe(true);
  expect(existsSync(theirs)).toBe(true);
  expect(readdirSync(processesDir()).sort()).toEqual([noteName(me), noteName(peer)].sort());
});

test("an owner Styre may not inspect counts as alive", async () => {
  const owner = await deadOwner();
  const dir = folderOf(owner);
  const note = writeNote(owner, dir);
  const real = procTable.probe;
  const spy = spyOn(procTable, "probe").mockImplementation((pid) =>
    pid === owner.pid ? { kind: "not-allowed" } : real(pid),
  );
  try {
    const r = await sweepOrphans({ stderr: () => {} });
    expect(r.tempFolders).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(note)).toBe(true);
});

test("a dead owner's folder is kept while one of its launch records is still on disk", async () => {
  const owner = { ...(await deadOwner()), pgid: 0 };
  const dir = folderOf(owner);
  const note = writeNote(owner, dir);
  // A record naming this very process: the stop refuses Styre itself, so the record stays.
  const self = startOf(process.pid);
  const record: LaunchRecord = {
    version: 1,
    pid: self.pid,
    startedAt: self.startedAt,
    bootId: bootId(),
    kind: "agent",
    ident: "ENG-31",
    stepId: 1,
    worktree: null,
    command: "standin",
    owner,
  };
  writeRecord(record);
  const r = await sweepOrphans({ stderr: () => {} });
  expect(r.failed.map((x) => x.pid)).toEqual([self.pid]);
  expect(r.tempFolders).toEqual([]);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(note)).toBe(true);
});

test("only a folder that is exactly what the note says is removed; anything else is said and left", async () => {
  const cases: { label: string; path: (o: Who) => string; why: string }[] = [
    {
      label: "a name that is not a command temp folder's",
      path: () => {
        const d = join(root, "styre-wt-Ab3xY9");
        mkdirSync(d);
        return d;
      },
      why: "its name is not a command temp folder's",
    },
    {
      label: "a symbolic link",
      path: (o) => {
        const target = folderOf(o, "Target");
        const link = join(root, "styre-cmd-Link00");
        symlinkSync(target, link);
        return link;
      },
      why: "it is not a folder (a symbolic link or another kind of file)",
    },
    {
      label: "a file",
      path: () => {
        const f = join(root, "styre-cmd-File00");
        writeFileSync(f, "keep me");
        return f;
      },
      why: "it is not a folder (a symbolic link or another kind of file)",
    },
    {
      label: "a relative path",
      path: () => "styre-cmd-Rel000",
      why: "its path is not absolute",
    },
    {
      label: "a suffix of the wrong length",
      path: (o) => folderOf(o, "Short"),
      why: "its name is not a command temp folder's",
    },
  ];
  for (const c of cases) {
    rmSync(processesDir(), { recursive: true, force: true });
    const owner = await deadOwner();
    const path = c.path(owner);
    const note = writeNote(owner, path);
    const before = readdirSync(root).sort();
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect({ label: c.label, removed: r.tempFolders, lines: out.lines }).toEqual({
      label: c.label,
      removed: [],
      lines: [
        `styre: did not remove ${path}, named by the temp folder note ${note}: ${c.why}; both were left in place\n`,
      ],
    });
    expect(readdirSync(root).sort()).toEqual(before);
    expect(existsSync(note)).toBe(true);
  }
  // The link's target and what it held are untouched.
  expect(readdirSync(root).some((n) => n.endsWith("-Target"))).toBe(true);
});

test("a note that cannot be used is said and left in place", async () => {
  mkdirSync(processesDir(), { recursive: true, mode: 0o700 });
  const dir = processesDir();
  writeFileSync(join(dir, "tmp-77-1.000000.json"), "not json");
  writeFileSync(
    join(dir, "tmp-88-1.000000.json"),
    JSON.stringify({
      version: 1,
      owner: { pid: 99, startedAt: "1.000000" },
      bootId: null,
      path: "/x",
    }),
  );
  mkdirSync(join(dir, "tmp-66-1.000000.json"));
  const out = collect();
  const r = await sweepOrphans({ stderr: out.stderr });
  expect(r.tempFolders).toEqual([]);
  expect(out.lines.sort()).toEqual(
    [
      `styre: ignored the temp folder note ${join(dir, "tmp-66-1.000000.json")}: it is not a regular file; it was left in place\n`,
      `styre: ignored the temp folder note ${join(dir, "tmp-77-1.000000.json")}: it is not valid JSON; it was left in place\n`,
      `styre: ignored the temp folder note ${join(dir, "tmp-88-1.000000.json")}: its content is not a version 1 temp folder note for the pid and start time in its name; it was left in place\n`,
    ].sort(),
  );
  expect(readdirSync(dir).sort()).toEqual(
    ["tmp-66-1.000000.json", "tmp-77-1.000000.json", "tmp-88-1.000000.json"].sort(),
  );
});

test("notes in a records folder others can write are never acted on", async () => {
  const owner = await deadOwner();
  const dir = folderOf(owner);
  const note = writeNote(owner, dir);
  chmodSync(processesDir(), 0o777);
  try {
    const out = collect();
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r.tempFolders).toEqual([]);
    expect(out.lines.length).toBe(1);
    expect(out.lines[0]).toStartWith(
      `styre: ignored the launch records folder ${processesDir()}: `,
    );
  } finally {
    chmodSync(processesDir(), 0o700);
  }
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(note)).toBe(true);
});

test.skipIf(bootId() === null)(
  "on Linux, a note from before the last restart names a Styre that is gone, whatever now has its pid",
  async () => {
    // This process's own identity, as if an earlier boot's Styre had had it.
    const me = startOf(process.pid);
    const dir = folderOf(me, "Boot00");
    const note = writeNote(me, dir, { bootId: "an-earlier-boot" });
    const r = await sweepOrphans({ stderr: () => {} });
    expect(r.tempFolders).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(note)).toBe(false);
  },
);

test("one sweep stops a force quit Styre's orphan and then removes its folder", async () => {
  const owner = { ...(await deadOwner()), pgid: 0 };
  const dir = folderOf(owner);
  writeNote(owner, dir);
  const orphan = Bun.spawn(["sleep", "4213"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  ownChild(orphan);
  const o = startOf(orphan.pid);
  writeRecord({
    version: 1,
    pid: o.pid,
    startedAt: o.startedAt,
    bootId: bootId(),
    kind: "agent",
    ident: "ENG-32",
    stepId: 1,
    worktree: null,
    command: "standin",
    owner,
  });
  const r = await sweepOrphans({ stderr: () => {} });
  expect(r.stopped.map((x) => x.pid)).toEqual([o.pid]);
  expect(r.tempFolders).toEqual([dir]);
  expect(existsSync(dir)).toBe(false);
});

test("when the records cannot be read again after the stops, no folder is removed", async () => {
  const owner = await deadOwner();
  const dir = folderOf(owner);
  const note = writeNote(owner, dir);
  const real = records.scanRecords;
  let calls = 0;
  const spy = spyOn(records, "scanRecords").mockImplementation(() => {
    calls++;
    if (calls > 1) throw new Error("the disk said no");
    return real();
  });
  const out = collect();
  try {
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r.tempFolders).toEqual([]);
  } finally {
    spy.mockRestore();
  }
  expect(out.lines).toEqual([
    "styre: could not read the launch records again (the disk said no), so no temp folders were removed\n",
  ]);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(note)).toBe(true);
});

test("a read-only tree in a force quit Styre's folder is removed too", async () => {
  const owner = await deadOwner();
  const dir = folderOf(owner);
  writeNote(owner, dir);
  const ro = join(dir, "mod", "pkg@v1");
  mkdirSync(ro, { recursive: true });
  writeFileSync(join(ro, "a.go"), "x");
  chmodSync(ro, 0o555);
  chmodSync(join(dir, "mod"), 0o555);
  const out = collect();
  try {
    const r = await sweepOrphans({ stderr: out.stderr });
    expect(r.tempFolders).toEqual([dir]);
  } finally {
    if (existsSync(ro)) {
      chmodSync(join(dir, "mod"), 0o700);
      chmodSync(ro, 0o700);
    }
  }
  expect(out.lines).toEqual([]);
  expect(existsSync(dir)).toBe(false);
});

test("a folder the sweep cannot remove is said once, with how to remove it, and its note goes", async () => {
  const owner = await deadOwner();
  const dir = folderOf(owner);
  const note = writeNote(owner, dir);
  chmodSync(root, 0o500); // the folder's entries go, the folder itself cannot
  const out = collect();
  try {
    await sweepOrphans({ stderr: out.stderr });
  } finally {
    chmodSync(root, 0o700);
  }
  expect(out.lines.length).toBe(1);
  expect(out.lines[0]).toStartWith(
    `styre: could not remove the temp folder ${dir} left by an earlier Styre: `,
  );
  expect(out.lines[0]).toEndWith(`; remove it with: chmod -R u+w ${dir} && rm -rf ${dir}\n`);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(note)).toBe(false);
  const again = collect();
  await sweepOrphans({ stderr: again.stderr });
  expect(again.lines).toEqual([]);
});
