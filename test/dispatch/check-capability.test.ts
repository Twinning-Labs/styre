import { expect, test } from "bun:test";
import {
  capabilityCommandFor,
  formatIncapable,
  probeCheckCapability,
  probeComponent,
} from "../../src/dispatch/check-capability.ts";
import type { Component } from "../../src/dispatch/profile.ts";
import type { CommandResult } from "../../src/util/run-command.ts";

/**
 * ENG-426. `probeCommandExists` probes the LEADING PROGRAM, so for `python3 -m pytest` it probes
 * `python3` — always present — and is structurally incapable of noticing pytest is absent. That
 * blindness surfaced on django__django-12325 only as a RED-first `No module named pytest`,
 * correctly classified `environmental` and therefore permanently advisory, after $6.42 had been
 * spent and a pull request opened.
 */
function comp(over: Partial<Component> & { name: string }): Component {
  return {
    kind: "python",
    paths: ["**"],
    commands: { test: "pytest" },
    extensions: [".py"],
    ...over,
  } as Component;
}

const ok = async (): Promise<CommandResult> => ({
  exitCode: 0,
  stdout: "pytest 8.4.2",
  stderr: "",
  timedOut: false,
});
const missing = async (): Promise<CommandResult> => ({
  exitCode: 1,
  stdout: "",
  stderr: "/opt/miniconda3/envs/testbed/bin/python3: No module named pytest",
  timedOut: false,
});

test("the pytest probe runs the INVOCATION, not just the interpreter", () => {
  // The whole point. `python3` on PATH proves nothing about pytest.
  expect(capabilityCommandFor("pytest", "python3 -m pytest")).toBe("python3 -m pytest --version");
});

test("go is overridden — `go test --version` is not a thing", () => {
  expect(capabilityCommandFor("go", "go test")).toBe("go version");
});

test("minitest is overridden — `ruby --version` would prove only that Ruby exists", () => {
  // Which is exactly the mistake this module was written to stop making.
  expect(capabilityCommandFor("minitest", "ruby -Itest")).toContain("require 'minitest/autorun'");
});

test("every other framework probes its own launcher", () => {
  expect(capabilityCommandFor("jest", "npm run test:ci --")).toBe("npm run test:ci -- --version");
  expect(capabilityCommandFor("cargo", "cargo test")).toBe("cargo test --version");
});

test("a framework that answers --version is runnable", async () => {
  const p = await probeComponent(comp({ name: "api" }), { worktreePath: "/w", run: ok });
  expect(p.runnable).toBe(true);
  expect(p.framework).toBe("pytest");
});

test("django's exact failure: the interpreter exists, pytest does not → NOT runnable", async () => {
  const p = await probeComponent(comp({ name: "python" }), { worktreePath: "/w", run: missing });
  expect(p.runnable).toBe(false);
  expect(p.framework).toBe("pytest");
  // The reason must name the framework, not leave the reader with a raw blob.
  expect(p.detail).toContain("python3 -m pytest --version");
  expect(p.detail).toContain("No module named pytest");
});

test("an unresolvable framework is an ANSWER, not a crash", async () => {
  // A ruby component whose test command names neither rspec nor minitest.
  const p = await probeComponent(comp({ name: "rb", kind: "ruby", commands: { test: "rake" } }), {
    worktreePath: "/w",
    run: ok,
  });
  expect(p.framework).toBeNull();
  expect(p.runnable).toBe(false);
  expect(p.detail).toContain("no test framework could be resolved");
});

test("a probe that times out reads as not runnable, never as runnable", async () => {
  const timeout = async (): Promise<CommandResult> => ({
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: true,
  });
  const p = await probeComponent(comp({ name: "api" }), { worktreePath: "/w", run: timeout });
  expect(p.runnable).toBe(false);
});

test("every component is probed, in order", async () => {
  const seen: string[] = [];
  const spy = async (command: string) => {
    seen.push(command);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const probes = await probeCheckCapability([comp({ name: "a" }), comp({ name: "b" })], {
    worktreePath: "/w",
    run: spy,
  });
  expect(probes.map((p) => p.component)).toEqual(["a", "b"]);
  expect(seen).toHaveLength(2);
});

test("the report names each incapable component and why", async () => {
  const probes = await probeCheckCapability([comp({ name: "python" })], {
    worktreePath: "/w",
    run: missing,
  });
  const text = formatIncapable(probes);
  expect(text).toContain("python");
  expect(text).toContain("No module named pytest");
});
