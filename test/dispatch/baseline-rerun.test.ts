import { expect, test } from "bun:test";
import { runAtBaseline } from "../../src/dispatch/baseline-rerun.ts";

// -- ENG-402: a delivered test must be shown to bind ---------------------------------------

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveredTestBindsAtBaseline } from "../../src/dispatch/baseline-rerun.ts";

function git(args: string[], cwd: string) {
  return Bun.spawnSync(["git", ...args], { cwd }).success;
}

/** A repo whose baseline has a buggy `add`, with the fix applied on top. */
function repoWithBaseline(): { repoPath: string; baselineSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "styre-bind-repo-"));
  git(["init", "-q", "."], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "add.sh"), "echo 3\n");
  git(["add", "-A"], dir);
  git(["commit", "-qm", "base"], dir);
  const baselineSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir })
    .stdout.toString()
    .trim();
  return { repoPath: dir, baselineSha };
}

test("an unqualified failing command cannot prove a delivered test binds", async () => {
  const { repoPath, baselineSha } = repoWithBaseline();
  const src = mkdtempSync(join(tmpdir(), "styre-bind-src-"));
  mkdirSync(join(src, "t"), { recursive: true });
  // Exits non-zero at the baseline → it distinguishes the two revisions.
  writeFileSync(join(src, "t", "a.test.sh"), "exit 1\n");
  const verdict = await deliveredTestBindsAtBaseline({
    repoPath,
    baselineSha,
    testFile: "t/a.test.sh",
    sourcePath: join(src, "t", "a.test.sh"),
    command: "sh t/a.test.sh",
    timeoutMs: 20_000,
  });
  expect(verdict).toBe("unknown");
});

test("an unqualified successful command cannot prove test execution", async () => {
  // `expect(true).toBe(true)` is the degenerate form, but an over-mocked or wrongly-scoped test
  // fails identically and reads as fine. This is what styre already proves for its own AC checks
  // via ac-check-red-first, and previously proved for nothing it delivered.
  const { repoPath, baselineSha } = repoWithBaseline();
  const src = mkdtempSync(join(tmpdir(), "styre-bind-src2-"));
  mkdirSync(join(src, "t"), { recursive: true });
  writeFileSync(join(src, "t", "a.test.sh"), "exit 0\n");
  const verdict = await deliveredTestBindsAtBaseline({
    repoPath,
    baselineSha,
    testFile: "t/a.test.sh",
    sourcePath: join(src, "t", "a.test.sh"),
    command: "sh t/a.test.sh",
    timeoutMs: 20_000,
  });
  expect(verdict).toBe("unknown");
});

test("an unusable baseline is unknown, never a verdict either way", async () => {
  const { repoPath } = repoWithBaseline();
  const src = mkdtempSync(join(tmpdir(), "styre-bind-src3-"));
  mkdirSync(join(src, "t"), { recursive: true });
  writeFileSync(join(src, "t", "a.test.sh"), "exit 1\n");
  const verdict = await deliveredTestBindsAtBaseline({
    repoPath,
    baselineSha: "0000000000000000000000000000000000000000",
    testFile: "t/a.test.sh",
    sourcePath: join(src, "t", "a.test.sh"),
    command: "sh t/a.test.sh",
    timeoutMs: 20_000,
  });
  expect(verdict).toBe("unknown");
});

import { existsSync } from "node:fs";
import { deliveredTestEvidenceAtBaseline } from "../../src/dispatch/baseline-rerun.ts";
import { resolveCheckExecution } from "../../src/dispatch/check-execution.ts";

test.each([
  [1, "E       assert 1 == 2\n1 failed in 0.01s", "binds"],
  [0, "1 passed in 0.01s", "does-not-bind"],
  [1, "No module named pytest", "unknown"],
  [1, "E   AttributeError: missing\n1 failed in 0.01s", "unknown"],
  [2, "1 error in 0.01s", "unknown"],
  [5, "no tests ran", "unknown"],
  [0, "1 skipped", "unknown"],
] as const)(
  "delivered baseline exit %s with %s gives %s and retains execution evidence",
  async (exitCode, stdout, verdict) => {
    const { repoPath, baselineSha } = repoWithBaseline();
    const sourcePath = join(repoPath, "delivered.py");
    writeFileSync(sourcePath, "def test_bug(): assert False\n");
    const plan = resolveCheckExecution({
      components: [
        {
          name: "api",
          kind: "python",
          dir: "api",
          paths: ["api/**"],
          commands: {},
          extensions: [".py"],
        },
      ],
      testFile: "api/tests/test_bug.py",
    });
    const evidence = await deliveredTestEvidenceAtBaseline({
      repoPath,
      baselineSha,
      testFile: plan.testFile,
      sourcePath,
      plan,
      timeoutMs: 1000,
      run: async (command, opts) => {
        expect(command).toContain("'tests/test_bug.py'");
        expect(opts.cwd.endsWith("/api")).toBe(true);
        expect(existsSync(join(opts.cwd, "tests/test_bug.py"))).toBe(true);
        return { exitCode, stdout, stderr: "", timedOut: false };
      },
    });
    expect(evidence.verdict).toBe(verdict);
    expect(evidence.execution?.rawOutput).toContain(stdout);
  },
);

test("missing baseline dependencies cannot certify a candidate failure as pre-existing", async () => {
  const { repoPath, baselineSha } = repoWithBaseline();
  // An ignored install is present in the candidate tree, absent in the detached baseline.
  writeFileSync(join(repoPath, "installed"), "yes");
  const observation = await runAtBaseline({
    repoPath,
    baselineSha,
    command:
      "if test -f installed; then echo assertion-failed; exit 1; else echo missing-dependency >&2; exit 127; fi",
    timeoutMs: 5000,
  });
  expect(observation.comparison).toBe("unqualified");
  expect(observation.execution?.outcome).toBe("completed-nonzero");
  expect(observation.execution?.stderr).toContain("missing-dependency");
  expect(observation.execution?.sha).toBe(baselineSha);
  expect(observation).not.toHaveProperty("preexisting");
});

test.each([0, 1])(
  "baseline exit %s is an observation, not a causal classification",
  async (code) => {
    const { repoPath, baselineSha } = repoWithBaseline();
    const observation = await runAtBaseline({
      repoPath,
      baselineSha,
      command: `echo stdout-evidence; echo stderr-evidence >&2; exit ${code}`,
      timeoutMs: 5000,
    });
    expect(observation.comparison).toBe("unqualified");
    expect(observation.execution?.exitCode).toBe(code);
    expect(observation.execution?.stdout).toContain("stdout-evidence");
    expect(observation.execution?.stderr).toContain("stderr-evidence");
  },
);
