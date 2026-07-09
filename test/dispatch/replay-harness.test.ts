import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { baselineShaForAc, replayCheckAtBaseline } from "../../src/dispatch/replay-harness.ts";
import { makeTestDb } from "../helpers/db.ts";

// FIX (transcription bug in the brief's Step 1): `Component` (profile.ts) has a REQUIRED
// `extensions: string[]` field (schemaVersion 3 file-identity routing) — the brief's fixture
// omitted it, which typechecks fine only where `Component` is duck-typed at runtime but fails
// `tsc --noEmit` wherever it's passed as a real `Component[]` (as `replayCheckAtBaseline` requires).
const PY = {
  name: "checks",
  kind: "python",
  paths: ["checks/**"],
  commands: {},
  extensions: [".py"],
};

// FIX (transcription bug in the brief's Step 1): ac_check.ac_id is a NOT-NULL FK to
// acceptance_criterion(id) (schema.sql). The brief hardcoded a bare `acId: 5`, which trips the FK
// constraint against a freshly-migrated test db (there is no acceptance_criterion row 5). Seed a
// real row and use its id instead — the test's actual point (baseline sha = the ORIGINAL check's
// sha, not the re-author's) is unaffected by which id it is.
function seedAc(db: Parameters<typeof insertAc>[0], ticketId: number): number {
  return insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" }).id;
}

function baselineRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-replay-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x"); // baseline has NO checks/ file
  run(["add", "-A"]);
  run(["commit", "-m", "clean baseline"]);
  return root;
}
function head(repo: string): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim();
}

test("baselineShaForAc reads the ORIGINAL (lowest-id) check's red-first sha, not a re-author's", () => {
  const { db, ticketId } = makeTestDb();
  const acId = seedAc(db, ticketId);
  const orig = insertAcCheck(db, {
    ticketId,
    acId,
    selector: "s",
    testPath: "checks/a_test.py",
    redFirstResult: "red",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    branchHeadSha: "CLEANSHA",
    detail: { rawOutput: "", exitCode: 1, framework: "pytest", command: null, acCheckId: orig.id },
  });
  db.query("UPDATE ac_check SET superseded_at = '2026-07-09T00:00:00Z' WHERE id = ?").run(orig.id);
  const reauth = insertAcCheck(db, {
    ticketId,
    acId,
    selector: "s",
    testPath: "checks/a_test.py",
    redFirstResult: "red",
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: "fail",
    branchHeadSha: "IMPLSHA",
    detail: {
      rawOutput: "",
      exitCode: 1,
      framework: "pytest",
      command: null,
      acCheckId: reauth.id,
    },
  });
  expect(baselineShaForAc(db, acId)).toBe("CLEANSHA"); // the clean baseline, NOT IMPLSHA
  db.close();
});

test("replayCheckAtBaseline overlays the absent-at-baseline file and returns the runner's coarse", async () => {
  const repo = baselineRepo();
  const coarse = await replayCheckAtBaseline({
    repoPath: repo,
    baselineSha: head(repo),
    components: [PY],
    testFile: "checks/a_test.py",
    testName: "test_ac",
    content: "def test_ac():\n    assert False\n",
    timeoutMs: 5000,
    run: async (_cmd, opts) => {
      // Prove the overlay: the file must be present in the detached worktree we run in, at the
      // SAME repo-relative path ("checks/a_test.py") under `opts.cwd` — `PY` sets no `dir`, so
      // `cwd` is the worktree ROOT (mirrors production `rerunOne`/`handlers.ts`, which pass a
      // repo-relative `testFile` and join only `comp.dir` onto cwd, never the file's own subpath).
      // FIX (transcription bug in the brief's Step 1): the brief's original probe checked
      // `opts.cwd/a_test.py` (no `checks/` segment) and `repo/checks/a_test.py` (the ORIGINAL repo,
      // which the detached worktree never writes into) — neither path is ever populated, so the
      // probe was always false. Traced via a standalone `git worktree add --detach` + overlay
      // repro: the file lands at `<wt>/checks/a_test.py`, confirming `opts.cwd` is the wt root.
      const present =
        Bun.spawnSync(["test", "-f", join(opts.cwd, "checks", "a_test.py")]).exitCode === 0;
      return { exitCode: present ? 1 : 99, stdout: "1 failed", stderr: "", timedOut: false };
    },
  });
  expect(coarse).toBe("red"); // pytest exit 1 → red (the caller installs on this)
});

test("replay returns green / selected-none / error verbatim so the caller can reject them", async () => {
  const repo = baselineRepo();
  const base = {
    repoPath: repo,
    baselineSha: head(repo),
    components: [PY],
    testFile: "checks/a_test.py",
    testName: "test_ac",
    content: "x",
    timeoutMs: 5000,
  };
  const green = await replayCheckAtBaseline({
    ...base,
    run: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }),
  });
  const none = await replayCheckAtBaseline({
    ...base,
    run: async () => ({ exitCode: 5, stdout: "no tests ran", stderr: "", timedOut: false }),
  });
  const err = await replayCheckAtBaseline({
    ...base,
    run: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }),
  });
  expect(green).toBe("green");
  expect(none).toBe("selected-none");
  expect(err).toBe("error");
});
