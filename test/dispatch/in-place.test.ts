import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertInPlaceIdentity,
  assertInPlaceMarker,
  assertInPlaceSafe,
  discoverRepoRoot,
} from "../../src/dispatch/in-place.ts";
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

test("safe: marker present + clean tracked tree passes (detached HEAD alone no longer suffices)", () => {
  const repo = tmpRepo();
  expect(() => assertInPlaceSafe(repo)).toThrow(/marker/);
  writeFileSync(join(repo, ".styre-disposable"), "");
  expect(() => assertInPlaceSafe(repo)).not.toThrow();
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
  writeFileSync(join(repo, ".styre-disposable"), ""); // marker present so this proves the tracked-dirty guard, not the marker guard
  writeFileSync(join(repo, "tracked.txt"), "x");
  Bun.spawnSync(["git", "add", "tracked.txt"], { cwd: repo });
  expect(() => assertInPlaceSafe(repo)).toThrow(/tracked/);
});

test("allow: untracked files present (editable-env residue must not false-refuse)", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, ".styre-disposable"), ""); // marker present so this proves the untracked-residue guard, not the marker guard
  writeFileSync(join(repo, "build.egg-info"), "residue");
  expect(() => assertInPlaceSafe(repo)).not.toThrow();
});

test("discoverRepoRoot returns the git toplevel of cwd", () => {
  const repo = tmpRepo();
  expect(discoverRepoRoot(repo)).toBe(
    Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: repo }).stdout.toString().trim(),
  );
});

test("discoverRepoRoot throws (fail-closed) when cwd is not a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "nonrepo-"));
  roots.push(dir);
  expect(() => discoverRepoRoot(dir)).toThrow(/no git repo/);
});

test("assertInPlaceMarker passes with a regular-file marker, throws without", () => {
  const repo = tmpRepo();
  expect(() => assertInPlaceMarker(repo)).toThrow(/marker/);
  writeFileSync(join(repo, ".styre-disposable"), "");
  expect(() => assertInPlaceMarker(repo)).not.toThrow();
});

test("assertInPlaceMarker rejects a non-regular-file marker (F5)", () => {
  const repo = tmpRepo();
  Bun.spawnSync(["mkdir", join(repo, ".styre-disposable")]);
  expect(() => assertInPlaceMarker(repo)).toThrow(/regular file/);
});

test("assertInPlaceMarker rejects a symlinked marker even when it points at a real regular file (F5)", () => {
  const repo = tmpRepo();
  const realFile = join(repo, "real-file.txt");
  writeFileSync(realFile, "");
  symlinkSync(realFile, join(repo, ".styre-disposable"));
  expect(() => assertInPlaceMarker(repo)).toThrow(/regular file/);
});

test("assertInPlaceSafe: marker required even on a NAMED branch (detached-HEAD dropped)", () => {
  const repo = tmpRepoOnBranch(); // on a named branch, no marker
  expect(() => assertInPlaceSafe(repo)).toThrow(/marker/);
  writeFileSync(join(repo, ".styre-disposable"), "");
  expect(() => assertInPlaceSafe(repo)).not.toThrow(); // marker present + clean → ok, branch state irrelevant
});

test("assertInPlaceSafe: tracked-dirty still refused", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, ".styre-disposable"), "");
  writeFileSync(join(repo, "f.txt"), "x");
  Bun.spawnSync(["git", "add", "f.txt"], { cwd: repo });
  expect(() => assertInPlaceSafe(repo)).toThrow(/tracked/);
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

// Multi-python profile, one component per subdir — each must be checked on ITS OWN dir (mirrors
// `provision`'s per-component `join(worktreePath, c.dir)`), not just the repo root.
function tmpMultiPyRepo(): { repo: string; okDir: string; badDir: string } {
  const repo = mkdtempSync(join(tmpdir(), "styre-inplace-multipy-"));
  roots.push(repo);
  const okDir = join(repo, "ok-comp");
  const badDir = join(repo, "bad-comp");
  mkdirSync(okDir, { recursive: true });
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(okDir, "pyproject.toml"), '[project]\nname = "ok_pkg"\n');
  writeFileSync(join(badDir, "pyproject.toml"), '[project]\nname = "bad_pkg"\n');
  return { repo, okDir, badDir };
}

test("identity: checks EACH python component on its own dir — throws naming the failing component", async () => {
  const { repo, okDir, badDir } = tmpMultiPyRepo();
  const profile = {
    targetRepo: repo,
    components: [
      { name: "good", kind: "python", paths: ["**"], commands: {}, dir: "ok-comp" },
      { name: "bad", kind: "python", paths: ["**"], commands: {}, dir: "bad-comp" },
    ],
  } as unknown as Profile;
  const run: typeof runCommand = async (_cmd, opts) => {
    // The 'good' component's source-check (cwd === okDir) passes; the 'bad' component
    // (cwd === badDir) fails — proving BOTH components are actually checked, per-dir.
    const exitCode = opts.cwd === okDir ? 0 : opts.cwd === badDir ? 2 : 99;
    return { exitCode, stdout: "", stderr: "", timedOut: false };
  };
  await expect(assertInPlaceIdentity(repo, profile, run)).rejects.toThrow(/bad/);
});

test("identity: a component with an underivable name is skipped (no throw) while others are still checked", async () => {
  const { repo, okDir } = tmpMultiPyRepo();
  const noDerivDir = join(repo, "no-deriv-comp");
  mkdirSync(noDerivDir, { recursive: true }); // no pyproject.toml / src layout → underivable
  const profile = {
    targetRepo: repo,
    components: [
      { name: "good", kind: "python", paths: ["**"], commands: {}, dir: "ok-comp" },
      { name: "noderiv", kind: "python", paths: ["**"], commands: {}, dir: "no-deriv-comp" },
    ],
  } as unknown as Profile;
  const run: typeof runCommand = async (_cmd, opts) => {
    if (opts.cwd === noDerivDir) {
      throw new Error("run should not be invoked for the underivable component");
    }
    expect(opts.cwd).toBe(okDir);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  await expect(assertInPlaceIdentity(repo, profile, run)).resolves.toBeUndefined();
});
