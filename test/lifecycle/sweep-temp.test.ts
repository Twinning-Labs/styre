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
function folderOf(owner: Who, suffix = "Ab3xY9"): string {
  const dir = join(root, `styre-cmd-${owner.pid}-${owner.startedAt}-${suffix}`);
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
  const note = writeNote(owner, join(root, `styre-cmd-${owner.pid}-${owner.startedAt}-Zz0000`));
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
  const theirs = folderOf(peer);
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
      label: "another owner's name",
      path: (o) => folderOf({ pid: o.pid + 1, startedAt: o.startedAt }),
      why: "its name is not the temp folder of the Styre the note names",
    },
    {
      label: "a symbolic link",
      path: (o) => {
        const target = folderOf(o, "Target");
        const link = join(root, `styre-cmd-${o.pid}-${o.startedAt}-Link00`);
        symlinkSync(target, link);
        return link;
      },
      why: "it is not a folder (a symbolic link or another kind of file)",
    },
    {
      label: "a file",
      path: (o) => {
        const f = join(root, `styre-cmd-${o.pid}-${o.startedAt}-File00`);
        writeFileSync(f, "keep me");
        return f;
      },
      why: "it is not a folder (a symbolic link or another kind of file)",
    },
    {
      label: "a relative path",
      path: (o) => `styre-cmd-${o.pid}-${o.startedAt}-Rel000`,
      why: "its path is not absolute",
    },
    {
      label: "a suffix of the wrong length",
      path: (o) => folderOf(o, "Short"),
      why: "its name is not the temp folder of the Styre the note names",
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
