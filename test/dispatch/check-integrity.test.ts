import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { insertAcCheck } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import { insertSignal } from "../../src/db/repos/ground-truth-signal.ts";
import { checkIntegrityViolations } from "../../src/dispatch/check-integrity.ts";
import { makeTestDb } from "../helpers/db.ts";

/** Mirrors verify-e2e.test.ts's gitRepo(): a real git repo fixture. */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ci-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

/** Write `file` (creating its directory) and commit everything, returning the new HEAD sha. */
function writeAndCommit(root: string, file: string, content: string, message: string): string {
  const full = join(root, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["add", "-A"]);
  run(["commit", "-m", message]);
  return run(["rev-parse", "HEAD"]).stdout.toString().trim();
}

function headSha(root: string): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
}

/** Seed a ticket-scoped AC, an active ac_check for it, and the RED-first signal (by the check's LIVE
 *  id) recording `authoringSha` as the authoring branch_head_sha. */
function seedCheck(
  db: Parameters<typeof insertAc>[0],
  ticketId: number,
  testPath: string,
  authoringSha: string | null,
): { acId: number; acCheckId: number } {
  const ac = insertAc(db, { ticketId, seq: 1, text: "ac", source: "checklist" });
  const check = insertAcCheck(db, {
    ticketId,
    acId: ac.id,
    selector: testPath,
    testPath,
    redFirstResult: "red",
  });
  if (authoringSha !== null) {
    insertSignal(db, {
      ticketId,
      signalType: "ac-check-red-first",
      result: "fail",
      branchHeadSha: authoringSha,
      detail: {
        rawOutput: "",
        exitCode: 1,
        framework: "pytest",
        command: "pytest",
        acCheckId: check.id,
      },
    });
  }
  return { acId: ac.id, acCheckId: check.id };
}

test("byte-identical check file at HEAD -> no violation", () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const sha = writeAndCommit(
    repo,
    "tests/test_api.py",
    "def test_x():\n    assert True\n",
    "author check",
  );
  seedCheck(db, ticketId, "tests/test_api.py", sha);

  const violations = checkIntegrityViolations(db, ticketId, repo, headSha(repo));
  db.close();
  expect(violations).toEqual([]);
});

test("modified check file at a later commit -> check-file-modified violation", () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const shaA = writeAndCommit(
    repo,
    "tests/test_api.py",
    "def test_x():\n    assert True\n",
    "author check",
  );
  const { acId, acCheckId } = seedCheck(db, ticketId, "tests/test_api.py", shaA);
  writeAndCommit(repo, "tests/test_api.py", "def test_x():\n    assert False\n", "weaken check");

  const violations = checkIntegrityViolations(db, ticketId, repo, headSha(repo));
  db.close();
  expect(violations).toEqual([
    { acId, acCheckId, path: "tests/test_api.py", reason: "check-file-modified" },
  ]);
});

test("a conftest.py added in the check's dir -> conftest-modified violation", () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const shaA = writeAndCommit(
    repo,
    "tests/test_api.py",
    "def test_x():\n    assert True\n",
    "author check",
  );
  const { acId, acCheckId } = seedCheck(db, ticketId, "tests/test_api.py", shaA);
  writeAndCommit(
    repo,
    "tests/conftest.py",
    "import pytest\n\n@pytest.fixture(autouse=True)\ndef _noop():\n    yield\n",
    "add conftest",
  );

  const violations = checkIntegrityViolations(db, ticketId, repo, headSha(repo));
  db.close();
  expect(violations).toEqual([
    { acId, acCheckId, path: "tests/conftest.py", reason: "conftest-modified" },
  ]);
});

test("an unrelated file change (e.g. a new dependency elsewhere) -> no false-block", () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const shaA = writeAndCommit(
    repo,
    "tests/test_api.py",
    "def test_x():\n    assert True\n",
    "author check",
  );
  seedCheck(db, ticketId, "tests/test_api.py", shaA);
  writeAndCommit(repo, "src/other.ts", "export const y = 2;\n", "unrelated change");

  const violations = checkIntegrityViolations(db, ticketId, repo, headSha(repo));
  db.close();
  expect(violations).toEqual([]);
});

test("an ac_check with no RED-first signal -> missing-authoring-sha violation", () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  writeAndCommit(repo, "tests/test_api.py", "def test_x():\n    assert True\n", "author check");
  const { acId, acCheckId } = seedCheck(db, ticketId, "tests/test_api.py", null);

  const violations = checkIntegrityViolations(db, ticketId, repo, headSha(repo));
  db.close();
  expect(violations).toEqual([
    { acId, acCheckId, path: "tests/test_api.py", reason: "missing-authoring-sha" },
  ]);
});
