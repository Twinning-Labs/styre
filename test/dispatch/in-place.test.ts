import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInPlaceIdentity, assertInPlaceSafe } from "../../src/dispatch/in-place.ts";
import type { Profile } from "../../src/dispatch/profile.ts";
import type { runCommand } from "../../src/util/run-command.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
});

// A real git repo, detached HEAD (the disposable-container shape), clean tree.
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-inplace-test-"));
  roots.push(dir);
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  run(["init", "-q"]);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"]);
  run(["checkout", "-q", "--detach"]);
  return dir;
}

// Same, but stays on a named branch (the "may be owned" shape the gate must refuse by default).
function tmpRepoOnBranch(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-inplace-test-branch-"));
  roots.push(dir);
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir });
  run(["init", "-q", "-b", "main"]);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "base"]);
  return dir;
}

test("safe: detached HEAD + clean tracked tree passes", () => {
  expect(() => assertInPlaceSafe(tmpRepo())).not.toThrow();
});

test("refuse: on a named branch with no marker", () => {
  expect(() => assertInPlaceSafe(tmpRepoOnBranch())).toThrow(/refused/);
});

test("allow: named branch but .styre-disposable marker present", () => {
  const repo = tmpRepoOnBranch();
  writeFileSync(join(repo, ".styre-disposable"), "");
  expect(() => assertInPlaceSafe(repo)).not.toThrow();
});

test("refuse: uncommitted tracked change", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "tracked.txt"), "x");
  Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: repo });
  expect(() => assertInPlaceSafe(repo)).toThrow(/refused/);
});

test("allow: untracked files present (editable-env residue must not false-refuse)", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "build.egg-info"), "residue");
  expect(() => assertInPlaceSafe(repo)).not.toThrow();
});

test("identity: skips (no throw) when profile has no python components", async () => {
  const profile = { targetRepo: "/repo", components: [] } as unknown as Profile;
  await expect(assertInPlaceIdentity("/repo", profile)).resolves.toBeUndefined();
});

// A real dir (not a git repo — assertInPlaceIdentity never touches git) with a derivable python
// import name, so the real (non-injected) `pythonImportName` derivation actually resolves an
// importName and the injected `run` (the only DI seam per the brief) gets exercised.
function tmpPyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-inplace-py-"));
  roots.push(dir);
  writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "py"\n');
  return dir;
}

test("identity: throws when import resolves outside the repo (injected)", async () => {
  const repo = tmpPyRepo();
  const profile = {
    targetRepo: repo,
    components: [{ name: "py", kind: "python", paths: ["**"], commands: {} }],
  } as unknown as Profile;
  const failing: typeof runCommand = async () => ({
    exitCode: 2,
    stdout: "",
    stderr: "",
    timedOut: false,
  }); // source-check "elsewhere"
  await expect(assertInPlaceIdentity(repo, profile, failing)).rejects.toThrow(/in-place/);
});

test("identity: resolves (no throw) when the source-check passes (injected)", async () => {
  const repo = tmpPyRepo();
  const profile = {
    targetRepo: repo,
    components: [{ name: "py", kind: "python", paths: ["**"], commands: {} }],
  } as unknown as Profile;
  const passing: typeof runCommand = async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });
  await expect(assertInPlaceIdentity(repo, profile, passing)).resolves.toBeUndefined();
});

test("identity: skips (no throw) when import name is underivable (no pyproject/src layout)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-inplace-noderiv-"));
  roots.push(dir);
  const profile = {
    targetRepo: dir,
    components: [{ name: "py", kind: "python", paths: ["**"], commands: {} }],
  } as unknown as Profile;
  const shouldNotBeCalled: typeof runCommand = async () => {
    throw new Error("run should not be invoked when importName is underivable");
  };
  await expect(assertInPlaceIdentity(dir, profile, shouldNotBeCalled)).resolves.toBeUndefined();
});
