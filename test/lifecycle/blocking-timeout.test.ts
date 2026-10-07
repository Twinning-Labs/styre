// ENG-485 Task 7: a timed out blocking call must not be misread at the call sites whose answer
// depends on the exit code. The door's test seam hands each site a killed call (no exit code, no
// output) or a plain failure, and the test checks what the site does with it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  deleteRemoteBranch,
  fileContentAt,
  pushBranch,
  stagedIndexEmpty,
} from "../../src/dispatch/worktree.ts";
import * as door from "../../src/util/process/door.ts";

const TIMED_OUT: door.BlockingResult = {
  timedOut: true,
  signalCode: null,
  exitCode: null,
  success: false,
  stdout: "",
  stderr: "",
};
const fail = (exitCode: number, stderr = "", stdout = ""): door.BlockingResult => ({
  timedOut: false,
  signalCode: null,
  exitCode,
  success: false,
  stdout,
  stderr,
});
const ok = (stdout = ""): door.BlockingResult => ({
  timedOut: false,
  signalCode: null,
  exitCode: 0,
  success: true,
  stdout,
  stderr: "",
});

let calls: string[][];
let stderr: string;
const realWrite = process.stderr.write.bind(process.stderr);

/** Answer each blocking call from `answer(argv)`, recording argv. */
function seam(answer: (argv: string[]) => door.BlockingResult): void {
  door.__setBlockingForTests((argv) => {
    calls.push(argv);
    return answer(argv);
  });
}
const pushed = (): boolean => calls.some((c) => c.includes("push"));

beforeEach(() => {
  door.__resetForTests();
  calls = [];
  stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = realWrite;
  door.__resetForTests();
});

test("stagedIndexEmpty: a timeout is an error, never 'empty' or 'has changes'", () => {
  seam(() => TIMED_OUT);
  expect(() => stagedIndexEmpty("/wt")).toThrow(/timed out after 30000 ms/);
});

test("stagedIndexEmpty keeps its exit code contract: 0 empty, 1 changes, anything else throws", () => {
  seam(() => ok());
  expect(stagedIndexEmpty("/wt")).toBe(true);
  seam(() => fail(1));
  expect(stagedIndexEmpty("/wt")).toBe(false);
  seam(() => fail(128, "fatal: boom"));
  expect(() => stagedIndexEmpty("/wt")).toThrow(/exit 128.*fatal: boom/);
});

test("deleteRemoteBranch: a timed out ls-remote warns and never pushes", () => {
  seam(() => TIMED_OUT);
  deleteRemoteBranch("/repo", "feat/x");
  expect(stderr).toContain("could not delete remote branch feat/x");
  expect(stderr).toContain("timed out after 120000 ms");
  expect(calls).toHaveLength(1);
  expect(pushed()).toBe(false);
});

test("deleteRemoteBranch: ls-remote exiting non zero (no remote) returns silently and never pushes", () => {
  seam(() => fail(128, "fatal: 'origin' does not appear to be a git repository"));
  deleteRemoteBranch("/repo", "feat/x");
  expect(stderr).toBe("");
  expect(calls).toHaveLength(1);
  expect(pushed()).toBe(false);
});

test("deleteRemoteBranch: an absent remote branch (empty ls-remote output) is silent", () => {
  seam(() => ok("\n"));
  deleteRemoteBranch("/repo", "feat/x");
  expect(stderr).toBe("");
  expect(pushed()).toBe(false);
});

test("deleteRemoteBranch: a present branch is deleted, and a failed or timed out delete warns", () => {
  const answer = (push: door.BlockingResult) => (argv: string[]) =>
    argv.includes("ls-remote") ? ok("abc\trefs/heads/feat/x\n") : push;
  seam(answer(ok()));
  deleteRemoteBranch("/repo", "feat/x");
  expect(pushed()).toBe(true);
  expect(stderr).toBe("");

  seam(answer(fail(1, "remote rejected")));
  deleteRemoteBranch("/repo", "feat/x");
  expect(stderr).toContain("remote rejected");

  stderr = "";
  seam(answer(TIMED_OUT));
  deleteRemoteBranch("/repo", "feat/x");
  expect(stderr).toContain("timed out after 120000 ms");
});

test("pushBranch: a timeout throws and names the timeout; a plain failure keeps git's own message", () => {
  seam(() => TIMED_OUT);
  expect(() => pushBranch("/repo", "feat/x")).toThrow(
    /git push failed for feat\/x: timed out after 120000 ms/,
  );
  expect(() => pushBranch("/repo", "feat/x", "abc")).toThrow(
    /force-with-lease.*timed out after 120000 ms/,
  );
  seam(() => fail(1, "rejected"));
  expect(() => pushBranch("/repo", "feat/x")).toThrow(/git push failed for feat\/x: rejected/);
  seam(() => ok());
  expect(() => pushBranch("/repo", "feat/x")).not.toThrow();
});

test("fileContentAt: a timeout reads as null, the same as an absent path (pinned as it is today)", () => {
  seam(() => TIMED_OUT);
  expect(fileContentAt("abc", "a.txt", "/wt")).toBeNull();
  seam(() => fail(128, "fatal: path does not exist"));
  expect(fileContentAt("abc", "a.txt", "/wt")).toBeNull();
  seam(() => ok("content\n"));
  expect(fileContentAt("abc", "a.txt", "/wt")).toBe("content\n");
});
