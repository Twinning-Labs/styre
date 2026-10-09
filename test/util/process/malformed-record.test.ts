// Final record review I1 (ruling R51): a launch record is data from a file, so a record-shaped file
// may hold anything. One whose fields have the wrong types must take the sweep's "unreadable record"
// path (said once, left in place, the command goes on), never reach a formatter that throws. And the
// sweep's error path itself must never throw: a failure while formatting its own line still puts
// the record back and lets the command go on.
//
// No process is started or signalled here: every record names pid 4321 from another boot (the sweep
// removes such a record without looking at its pid), or is refused before anything is looked at.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lsCommand } from "../../../src/cli/ls.ts";
import * as door from "../../../src/util/process/door.ts";
import { processesDir, recordFileName } from "../../../src/util/process/records.ts";
import { sweepOrphans } from "../../../src/util/process/sweep.ts";
import { makeTempDir } from "../../helpers/temp.ts";

let state: string;
const saved = process.env.XDG_STATE_HOME;
beforeEach(() => {
  state = makeTempDir("styre-malformed-");
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  if (saved === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
  else process.env.XDG_STATE_HOME = saved;
  rmSync(state, { recursive: true, force: true });
  door.__resetForTests();
});

/** A well formed record from another boot, with `over` applied (a key set to undefined is left
 *  out of the file). */
function writeRecordFile(over: Record<string, unknown> = {}): string {
  const r: Record<string, unknown> = {
    version: 1,
    pid: 4321,
    startedAt: "1.000000",
    bootId: "not-this-boot",
    kind: "agent",
    ident: "ENG-1",
    stepId: 1,
    worktree: null,
    command: "claude",
    owner: { pid: 999999, startedAt: "1.000000", pgid: 999999 },
    ...over,
  };
  const name = recordFileName({ pid: 4321, startedAt: "1.000000" });
  mkdirSync(processesDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(processesDir(), name), JSON.stringify(r), { mode: 0o600 });
  return name;
}

const ignoredLine = (name: string): string =>
  `styre: ignored the launch record ${join(processesDir(), name)}: its content is not a version 1 launch record for the pid and start time in its name; it was left in place\n`;

const SHAPES: [string, Record<string, unknown>][] = [
  ["an ident of 5", { ident: 5 }],
  ["no ident at all", { ident: undefined }],
  ["an object ident", { ident: { toString: "x" } }],
  ["a stepId that is not a number", { stepId: "1" }],
  ["a worktree that is not a string", { worktree: 7 }],
  ["a bootId that is not a string", { bootId: 7 }],
];

for (const [what, over] of SHAPES) {
  test(`the sweep reports a record with ${what} as unreadable and leaves it in place`, async () => {
    const name = writeRecordFile(over);
    const lines: string[] = [];
    const r = await sweepOrphans({ stderr: (s) => lines.push(s) });
    expect(lines).toEqual([ignoredLine(name)]);
    expect(r.stopped).toEqual([]);
    expect(readdirSync(processesDir())).toEqual([name]); // not removed, not left claimed
  });

  test(`styre ls with a record with ${what}: the line on stderr, the listing on stdout, no internal error`, async () => {
    const name = writeRecordFile(over);
    const out: string[] = [];
    const err: string[] = [];
    const spies = [
      spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
        out.push(String(c));
        return true;
      }),
      spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
        err.push(String(c));
        return true;
      }),
    ];
    const prevExit = process.exitCode;
    process.exitCode = 0;
    let code: number | string | undefined;
    try {
      const run = lsCommand.run as (ctx: unknown) => Promise<void>;
      await run({ args: { _: [] }, rawArgs: [], cmd: lsCommand });
    } finally {
      code = process.exitCode;
      process.exitCode = prevExit ?? 0;
      for (const s of spies) s.mockRestore();
    }
    expect(code).toBe(0);
    expect(err).toEqual([ignoredLine(name)]);
    expect(out.join("")).toContain("Paused/resumable efforts:");
    expect(readdirSync(processesDir())).toEqual([name]);
  });
}

test("a failure whose own description throws never escapes the sweep, and the record is put back", async () => {
  const name = writeRecordFile();
  // An error whose message and string form both throw: describing it is the formatter that fails.
  const hostile = {
    get message(): string {
      throw new Error("no message");
    },
    toString(): string {
      throw new Error("no string");
    },
  };
  const lines: string[] = [];
  const r = await sweepOrphans({
    stderr: (s) => lines.push(s),
    afterClaim: () => {
      throw hostile;
    },
  });
  expect(r.failed.map((f) => f.pid)).toEqual([4321]);
  expect(lines).toEqual([
    "styre: could not finish with the launch record for pid 4321 from ENG-1: an error that could not be described\n",
  ]);
  // Put back under its own name: not removed, and no claim left behind.
  expect(readdirSync(processesDir())).toEqual([name]);
  expect(existsSync(join(processesDir(), name))).toBe(true);
});
