// ENG-485 final review A F10: two fallbacks the new timeouts and the launch record made silent.
//  - runCommand: a command that could not be launched (no such folder, or a launch record that
//    could not be written) throws, as runCommand's spawn failure did before ENG-485. It is never
//    returned as an ordinary command result, which a verify step would read as red ground truth.
//  - tryGit: a git call that timed out throws. It is never read as "no remote", which made
//    deriveSlug silently pick the folder name, a different state folder, where --resume could not
//    find its checkpoint.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSlug, tryGit } from "../../src/config/slug.ts";
import * as door from "../../src/util/process/door.ts";
import { runCommand } from "../../src/util/run-command.ts";

let state: string;
const saved = process.env.XDG_STATE_HOME;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "styre-loud-"));
  process.env.XDG_STATE_HOME = state;
  door.__resetForTests();
});
afterEach(() => {
  door.__resetForTests();
  process.env.XDG_STATE_HOME = saved;
  rmSync(state, { recursive: true, force: true });
});

test("runCommand throws when the command cannot be launched in its folder", async () => {
  await expect(
    runCommand("true", { cwd: join(state, "no-such-folder"), timeoutMs: 5_000 }),
  ).rejects.toThrow();
});

test("runCommand throws when the launch record cannot be written, and nothing is left running", async () => {
  // The records folder's path is taken by a file, so the record cannot be written.
  const blocked = join(state, "blocked");
  writeFileSync(blocked, "");
  process.env.XDG_STATE_HOME = blocked;
  await expect(runCommand("sleep 21.0119", { cwd: state, timeoutMs: 5_000 })).rejects.toThrow(
    /could not write the launch record for pid \d+, so the launch was stopped/,
  );
  expect(door.liveLaunches()).toEqual([]);
});

const TIMED_OUT: door.BlockingResult = {
  timedOut: true,
  signalCode: null,
  exitCode: null,
  success: false,
  stdout: "",
  stderr: "",
};

test("tryGit throws when git timed out; a plain failure is still null", () => {
  door.__setBlockingForTests(() => TIMED_OUT);
  expect(() => tryGit(["config", "--get", "remote.origin.url"], state)).toThrow(
    /git config --get remote\.origin\.url timed out after 30000 ms/,
  );
  door.__setBlockingForTests(() => ({ ...TIMED_OUT, timedOut: false, exitCode: 1 }));
  expect(tryGit(["config", "--get", "remote.origin.url"], state)).toBeNull();
});

test("deriveSlug never falls back to the folder name when git timed out", () => {
  door.__setBlockingForTests(() => TIMED_OUT);
  expect(() => deriveSlug(join(state, "some-repo"))).toThrow(/timed out/);
});
