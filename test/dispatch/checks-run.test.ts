import { describe, expect, test } from "bun:test";
import { runCheckForRed } from "../../src/dispatch/checks-run.ts";
import type { CommandResult } from "../../src/util/run-command.ts";

const fakeRun =
  (out: Partial<CommandResult>) =>
  async (_command: string, _opts: { cwd: string; timeoutMs: number }): Promise<CommandResult> => {
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...out };
  };

describe("runCheckForRed", () => {
  test("assembles `<binary> <runArgs>` and reads a RED from a failing pytest run", async () => {
    const res = await runCheckForRed({
      framework: "pytest",
      binary: "python3 -m pytest",
      runArgs: "'tests/t.py::test_ok'",
      cwd: "/repo",
      timeoutMs: 1000,
      run: fakeRun({ exitCode: 1, stdout: "1 failed" }),
    });
    expect(res.command).toBe("python3 -m pytest 'tests/t.py::test_ok'");
    expect(res.coarse).toBe("red");
    expect(res.rawOutput).toContain("1 failed");
    expect(res.exitCode).toBe(1);
  });

  test("passes selected-none straight through (identity reject signal, §5.1)", async () => {
    const res = await runCheckForRed({
      framework: "pytest",
      binary: "python3 -m pytest",
      runArgs: "'tests/t.py::wrong_name'",
      cwd: "/repo",
      timeoutMs: 1000,
      run: fakeRun({ exitCode: 5 }), // pytest: no tests collected
    });
    expect(res.coarse).toBe("selected-none");
  });

  test("a timeout is error", async () => {
    const res = await runCheckForRed({
      framework: "go",
      binary: "go test",
      runArgs: "-run '^TestX$' ./pkg",
      cwd: "/repo",
      timeoutMs: 1,
      run: fakeRun({ exitCode: null, timedOut: true }),
    });
    expect(res.coarse).toBe("error");
    expect(res.exitCode).toBeNull();
  });
});
