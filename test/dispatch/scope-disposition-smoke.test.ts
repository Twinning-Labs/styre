// Adversarial scope-disposition smoke matrix — every cell of
// docs/plans/2026-07-19-scope-disposition-smoke-matrix.md driven through the REAL machinery:
//  - checks:dispatch (A) + verify sweep (G4): the full-loop handler harness (buildDispatchRegistry +
//    FakeAgentRunner + advanceOneStep + real SQLite + real git worktree), exactly as
//    checks-handler.test.ts does.
//  - implement:dispatch (C, D): the REAL implement handler resolved from the registry and invoked
//    directly (its discard-mode re-dispatch guard + revert live in the handler, not run-dispatch).
//  - checks re-author (B), design/plan (E), docs:revise (F), cross-cutting (G): runAgentDispatch with
//    the REAL scope factory + REAL disposition the corresponding handler wires (the fallback the brief
//    permits for path-scoped steps and the re-author call site) — never a hand-rolled fake scope.
//
// Negatives (⚔) assert BOTH the wrong file is NOT committed AND the guard outcome fired; each ⚔ cell is
// non-vacuous via a contrast pair that differs only in the guarded dimension (see smoke-report.md).

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchNameFor } from "../../src/agent/branch.ts";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import type { HandlerContext } from "../../src/daemon/step-registry.ts";
import { listByTicket as listAcChecks } from "../../src/db/repos/ac-check.ts";
import { listByTicket as listDispatches } from "../../src/db/repos/dispatch.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { getTicket, setTicketTrack } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { getByKey, insertPending } from "../../src/db/repos/workflow-step.ts";
import {
  checksScopeFor,
  docScope,
  implementScope,
  planScope,
} from "../../src/dispatch/commit-scope.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runAgentDispatch } from "../../src/dispatch/run-dispatch.ts";
import { ensureWorktree } from "../../src/dispatch/worktree.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

// ---------------------------------------------------------------------------------------------------
// git + worktree helpers
// ---------------------------------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  return Bun.spawnSync(["git", "-C", cwd, ...args])
    .stdout.toString()
    .trim();
}

/** A fresh git repo with README.md committed plus any `extra` tracked files. */
function gitRepo(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "styre-sds-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

/** The paths committed by HEAD (its diff vs parent), newline-joined. */
function committedAtHead(wt: string): string {
  return Bun.spawnSync(["git", "show", "--name-only", "--format=", "HEAD"], {
    cwd: wt,
  }).stdout.toString();
}

/** True iff `path` exists in the HEAD tree. */
function headHas(wt: string, path: string): boolean {
  return Bun.spawnSync(["git", "cat-file", "-e", `HEAD:${path}`], { cwd: wt }).success;
}

const pythonProfile = (repo: string) =>
  parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
  });

const nodeProfile = (repo: string) =>
  parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "web", kind: "node", paths: ["**"], commands: { test: "vitest run" } }],
  });

const goProfile = (repo: string) =>
  parseProfile({
    slug: "demo",
    targetRepo: repo,
    components: [{ name: "svc", kind: "go", paths: ["**"], commands: { test: "go test ./..." } }],
  });

const rubyProfile = (repo: string) =>
  parseProfile({
    slug: "demo",
    targetRepo: repo,
    // `commands.test` MUST name rspec or minitest — frameworkFor returns null otherwise.
    components: [
      { name: "app", kind: "ruby", paths: ["**"], commands: { test: "bundle exec rspec" } },
    ],
  });

type Cmd = (
  cmd: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;

/** The default RED-first oracle used by checks:dispatch tests: every check runs red (fails). */
const redRun: Cmd = async () => ({ exitCode: 1, stdout: "1 failed", stderr: "", timedOut: false });

const sidecar = (obj: unknown) => `x\n\`\`\`styre-sidecar\n${JSON.stringify(obj)}\n\`\`\``;

// ---------------------------------------------------------------------------------------------------
// A / G4: full-loop checks:dispatch + verify:check harness (real registry, real worktree)
// ---------------------------------------------------------------------------------------------------

async function markDesignDone(db: Parameters<typeof runStep>[0], ticketId: number) {
  await runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => ({ ok: true }),
  });
}

interface ChecksHarness {
  db: ReturnType<typeof makeTestDb>["db"];
  ticketId: number;
  repo: string;
  worktreeRoot: string;
  ident: string;
  acId: () => number;
}

/** Seed design→provision→checks:dispatch seam (mirrors checks-handler.test.ts). */
async function setupChecks(desc: string): Promise<ChecksHarness> {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(desc, ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-sdswt-"));
  return {
    db,
    ticketId,
    repo,
    worktreeRoot,
    ident: "ENG-1",
    acId: () =>
      (
        db
          .query("SELECT id FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq LIMIT 1")
          .get(ticketId) as { id: number }
      ).id,
  };
}

/** Drive provision then checks:dispatch. `beforeChecks` runs against the created worktree between the
 *  two steps (to inject pre-existing cruft into `untrackedBefore`). */
async function driveChecks(
  h: ChecksHarness,
  runner: FakeAgentRunner,
  opts?: {
    runCheck?: Cmd;
    beforeChecks?: (wt: string) => void;
    profile?: ReturnType<typeof parseProfile>;
  },
) {
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: opts?.profile ?? pythonProfile(h.repo),
    worktreeRoot: h.worktreeRoot,
    runCheckCommand: opts?.runCheck ?? redRun,
  });
  await advanceOneStep(h.db, h.ticketId, registry); // provision (creates the worktree)
  const wt = join(h.worktreeRoot, h.ident);
  opts?.beforeChecks?.(wt);
  const outcome = await advanceOneStep(h.db, h.ticketId, registry); // checks:dispatch
  const step = getByKey(h.db, h.ticketId, "checks:dispatch");
  const message = step?.error_json != null ? (JSON.parse(step.error_json).message ?? "") : "";
  return { outcome, step, wt, message };
}

/** A FakeAgentRunner whose callback can look up the (lazily-derived) ac id + ident. */
function checksRunner(
  h: ChecksHarness,
  apply: (cwd: string, acId: number, ident: string) => void,
  stdout: (acId: number, ident: string) => string,
): FakeAgentRunner {
  return new FakeAgentRunner((input) => {
    const acId = h.acId();
    apply(input.cwd, acId, h.ident);
    return {
      completed: true,
      exitCode: 0,
      stdout: stdout(acId, h.ident),
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });
}

const canonicalTest = (dir: string, acId: number, ident: string, body: string) => {
  const full = join(dir, "checks");
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, `${ident}_ac${acId}_test.py`), body);
};
const canonicalDeclared = (acId: number, ident: string, extra: Record<string, unknown> = {}) =>
  `\`\`\`styre-sidecar\n${JSON.stringify({
    checksAuthored: [
      { ac_id: acId, test_file: `checks/${ident}_ac${acId}_test.py`, test_name: "test_x" },
    ],
    ...extra,
  })}\n\`\`\``;

// --- A1 -----------------------------------------------------------------------------------------
test("A1 checks:dispatch commits a declared canonical test (happy path)", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => canonicalTest(cwd, acId, ident, "def test_x():\n    assert False\n"),
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, step, wt } = await driveChecks(h, runner);
  h.db.close();
  expect(outcome.kind).toBe("stepped");
  expect(step?.status).toBe("succeeded");
  expect(committedAtHead(wt)).toContain("_ac1_test.py");
});

// --- A2 (ENG-296 basename recognition) ----------------------------------------------------------
test("A2 canonical basename at a path != declared is committed (ENG-296)", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "tests", "styre_checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_x():\n    assert False\n");
    },
    // DECLARE a flat, different path; the canonical basename under styre_checks/ is what's committed.
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `tests/${ident}_ac${acId}_test.py`, test_name: "test_x" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, wt } = await driveChecks(h, runner);
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(outcome.kind).toBe("stepped");
  expect(committedAtHead(wt)).toContain("tests/styre_checks/");
  expect(checks[0]?.test_path).toContain("styre_checks/");
});

// --- A3 (ENG-323 heuristic deleted — an undeclared support file is discarded like any other) -----
test("A3 an UNDECLARED styre_checks/__init__.py co-located with the canonical test is discarded, not auto-admitted (ENG-323 deleted)", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "tests", "styre_checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_x():\n    assert False\n");
      writeFileSync(join(dir, "__init__.py"), ""); // undeclared support file
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          {
            ac_id: acId,
            test_file: `tests/styre_checks/${ident}_ac${acId}_test.py`,
            test_name: "test_x",
          },
        ],
        new_files: [],
      })}\n\`\`\``,
  );
  const { outcome, wt } = await driveChecks(h, runner);
  h.db.close();
  expect(outcome.kind).toBe("stepped"); // discard, not reject
  const committed = committedAtHead(wt);
  expect(committed).not.toContain("__init__.py"); // undeclared → discarded, no longer auto-admitted
  expect(committed).toContain("_ac1_test.py"); // the declared canonical test still commits
});

// --- A4 ⚔ (the live-bug fix: discard, not reject) -----------------------------------------------
test("A4 ⚔ an undeclared loose scratch is DISCARDED (+note) while the declared test COMMITS — no reject", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      canonicalTest(cwd, acId, ident, "def test_x():\n    assert False\n");
      writeFileSync(join(cwd, "scratch.py"), "# undeclared loose throwaway\n");
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, step, wt } = await driveChecks(h, runner);
  const events = listEvents(h.db, h.ticketId);
  h.db.close();
  expect(outcome.kind).toBe("stepped"); // proceeds, not rejected
  expect(step?.status).toBe("succeeded");
  expect(existsSync(join(wt, "scratch.py"))).toBe(false); // discarded from disk
  expect(committedAtHead(wt)).not.toContain("scratch.py"); // never committed
  expect(committedAtHead(wt)).toContain("_ac1_test.py"); // the declared test IS committed
  const notes = events.filter((e) => e.reason?.startsWith("scope-discarded"));
  expect(notes.length).toBeGreaterThan(0);
  // G3: the note lists exactly the discarded path.
  expect(JSON.parse(notes[0]?.payload_json ?? "{}").discarded).toEqual(["scratch.py"]);
});

// --- A5 (checksScopeFor allows tracked edits) ---------------------------------------------------
test("A5 an in-scope tracked edit is committed alongside the new test", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      canonicalTest(cwd, acId, ident, "def test_x():\n    assert False\n");
      writeFileSync(join(cwd, "README.md"), "edited by the checks author\n"); // tracked edit
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, wt } = await driveChecks(h, runner);
  h.db.close();
  expect(outcome.kind).toBe("stepped");
  const committed = committedAtHead(wt);
  expect(committed).toContain("README.md");
  expect(committed).toContain("_ac1_test.py");
});

// --- A6 ⚔ (rename-safety: unpaired deletion + undeclared new → REJECT) ---------------------------
test("A6 ⚔ an undeclared new file alongside an unpaired tracked deletion is REJECTED (rename-safety)", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      canonicalTest(cwd, acId, ident, "def test_x():\n    assert False\n");
      rmSync(join(cwd, "README.md")); // bare tracked deletion
      writeFileSync(join(cwd, "moved.py"), "content\n"); // undeclared new (looks like the move target)
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner);
  const dispatches = listDispatches(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(headHas(wt, "moved.py")).toBe(false); // never committed
  expect(existsSync(join(wt, "moved.py"))).toBe(false); // attempt undone
  expect(message).toMatch(/out-of-scope files/);
  expect(message).toMatch(/deletion|possible move/);
  expect(dispatches.some((d) => d.outcome === "dispatch-failed")).toBe(true);
});

// --- A7 (git-detected paired rename → COMMIT both halves) ---------------------------------------
test("A7 a git-detected paired rename commits both halves (not discarded)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo({ "tracked.py": "# tracked payload\n" });
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run("- [ ] one thing\n", ticketId);
  await markDesignDone(db, ticketId);
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-sdswt-"));
  const h: ChecksHarness = {
    db,
    ticketId,
    repo,
    worktreeRoot,
    ident: "ENG-1",
    acId: () =>
      (
        db
          .query("SELECT id FROM acceptance_criterion WHERE ticket_id = ? ORDER BY seq LIMIT 1")
          .get(ticketId) as { id: number }
      ).id,
  };
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      canonicalTest(cwd, acId, ident, "def test_x():\n    assert False\n");
      Bun.spawnSync(["git", "-C", cwd, "mv", "tracked.py", "renamed.py"]); // git-detected rename
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, wt } = await driveChecks(h, runner);
  db.close();
  expect(outcome.kind).toBe("stepped");
  expect(headHas(wt, "renamed.py")).toBe(true);
  expect(headHas(wt, "tracked.py")).toBe(false);
});

// --- A8 (primary sweep runs before the guard) ---------------------------------------------------
test("A8 a styre_scratch/ drawer is swept, the declared test commits", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      canonicalTest(cwd, acId, ident, "def test_x():\n    assert False\n");
      mkdirSync(join(cwd, "styre_scratch"), { recursive: true });
      writeFileSync(join(cwd, "styre_scratch", "probe.py"), "scratch\n");
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, wt } = await driveChecks(h, runner);
  const events = listEvents(h.db, h.ticketId);
  h.db.close();
  expect(outcome.kind).toBe("stepped");
  expect(existsSync(join(wt, "styre_scratch"))).toBe(false); // swept
  expect(committedAtHead(wt)).not.toContain("probe.py");
  expect(committedAtHead(wt)).toContain("_ac1_test.py");
  expect(events.some((e) => e.reason?.startsWith("scratch-swept"))).toBe(true);
});

// --- A9 (pre-existing untracked cruft is spared) ------------------------------------------------
test("A9 a pre-existing *.egg-info (untrackedBefore) is spared — not judged, not discarded", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => canonicalTest(cwd, acId, ident, "def test_x():\n    assert False\n"),
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, wt } = await driveChecks(h, runner, {
    beforeChecks: (worktree) => {
      mkdirSync(join(worktree, "pkg.egg-info"), { recursive: true });
      writeFileSync(join(worktree, "pkg.egg-info", "PKG-INFO"), "meta\n"); // pre-existing cruft
    },
  });
  h.db.close();
  expect(outcome.kind).toBe("stepped");
  expect(existsSync(join(wt, "pkg.egg-info", "PKG-INFO"))).toBe(true); // spared on disk
  expect(committedAtHead(wt)).not.toContain("egg-info"); // never committed
  expect(committedAtHead(wt)).toContain("_ac1_test.py");
});

// --- A10 ⚔ (malformed sidecar → scope defers → handler re-parses → RE-DISPATCH) ------------------
test("A10 ⚔ a malformed sidecar rolls back to preHead and re-dispatches (no commit survives)", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => canonicalTest(cwd, acId, ident, "def test_x():\n    assert False\n"),
    () => "```styre-sidecar\n{ this is not valid json\n```",
  );
  const { outcome, step, wt } = await driveChecks(h, runner);
  const dispatches = listDispatches(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(headHas(wt, "checks/ENG-1_ac1_test.py")).toBe(false); // rolled back to preHead
  expect(existsSync(join(wt, "checks", "ENG-1_ac1_test.py"))).toBe(false); // working tree reset
  expect(dispatches.some((d) => d.outcome === "reverted")).toBe(true);
});

// --- A11 ⚔ (discarded helper → import-error RED → uncovered → SURFACE in feedback) ---------------
// A canonical test that IMPORTS an undeclared helper placed outside styre_checks/: the helper is
// discarded, so the test can't import it → pytest exit 2 (collection/import error), coarse RED — NOT
// selected-none. The discard-poison guard (importErrorImplicatesDiscarded) routes this RED to the same
// uncovered path selected-none uses, so no permanently-broken check is installed and the discarded
// helper is NAMED in the feedback. Non-vacuous: without the guard the import-error RED marks the AC
// covered and a broken check is persisted.
test("A11 ⚔ a canonical test importing a discarded helper → import-error RED → AC uncovered, helper NAMED", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.py`),
        "from util import helper\n\ndef test_x():\n    assert helper()\n",
      );
      writeFileSync(join(dir, "util.py"), "def helper():\n    return False\n"); // undeclared loose helper
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  // The discarded helper is gone at run time → pytest can't collect the test module → exit 2, import
  // error naming the discarded module `util`.
  const { outcome, step, wt, message } = await driveChecks(h, runner, {
    runCheck: async () => ({
      exitCode: 2,
      stdout:
        "ImportError while importing test module\nE   ModuleNotFoundError: No module named 'util'",
      stderr: "",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(existsSync(join(wt, "checks", "util.py"))).toBe(false); // discarded
  expect(headHas(wt, "checks/ENG-1_ac1_test.py")).toBe(false); // reverted, no poisoned check committed
  expect(checks).toHaveLength(0); // NO covered check persisted for the AC
  expect(message).toMatch(/import or collection error/);
  expect(message).toContain("util.py"); // surfaced, recoverable
});

// --- A13 ⚔ (true-negative: a legit fail-first RED must NOT be rejected just because throwaway was
//            discarded) — CONTRAST for A11 -------------------------------------------------------
// The check legitimately fails because the FEATURE under test is absent (RED-first): the import error
// names the feature module `newfeature`, not the discarded file. An UNRELATED throwaway is discarded.
// The guard must NOT fire → the AC stays COVERED and the RED check is installed (classify judges it).
test("A13 ⚔ a fail-first RED naming the FEATURE (not the discarded throwaway) stays COVERED", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.py`),
        "from newfeature import go\n\ndef test_x():\n    assert go()\n",
      );
      writeFileSync(join(cwd, "scratch.py"), "# unrelated throwaway probe\n"); // undeclared, discarded
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  // RED because the not-yet-built feature module is absent — import error names `newfeature`, NOT the
  // discarded `scratch.py`.
  const { outcome, step, wt } = await driveChecks(h, runner, {
    runCheck: async () => ({
      exitCode: 2,
      stdout:
        "ImportError while importing test module\nE   ModuleNotFoundError: No module named 'newfeature'",
      stderr: "",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(outcome.kind).toBe("stepped"); // NOT rejected
  expect(step?.status).toBe("succeeded");
  expect(existsSync(join(wt, "scratch.py"))).toBe(false); // throwaway still discarded
  expect(committedAtHead(wt)).toContain("_ac1_test.py"); // the RED check IS committed
  expect(checks).toHaveLength(1);
  expect(checks[0]?.red_first_result).toBe("red"); // installed as RED (classify judges absence later)
});

// --- A14 ⚔ (ENG-342: a discarded __init__.py whose absence names the PACKAGE, not the file →
//            shape-matched → uncovered → SURFACE) -------------------------------------------------
// The canonical test imports package `pkg`; the agent wrote pkg/__init__.py but did NOT declare it →
// discarded. pytest can't import the package → exit 2, "No module named 'pkg'" — which names the
// PACKAGE, never the file `__init__.py`. The general name/basename tiers miss it; the package-init
// shape tier ties `pkg/__init__.py` to `No module named 'pkg'` → uncovered, file surfaced. Non-vacuous:
// without the shape tier this import-error RED marks the AC covered and a broken check persists (the
// exact masquerade ENG-342 closes). Contrast: A15 (a bare interior name must NOT match).
test("A14 ⚔ a discarded __init__.py named only via its package (No module named 'pkg') → AC uncovered, file surfaced", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.py`),
        "import pkg\n\ndef test_x():\n    assert pkg.x\n",
      );
      const pkgDir = join(cwd, "pkg");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "__init__.py"), "x = 1\n"); // undeclared package marker → discarded
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner, {
    runCheck: async () => ({
      exitCode: 2,
      stdout:
        "ImportError while importing test module\nE   ModuleNotFoundError: No module named 'pkg'",
      stderr: "",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(existsSync(join(wt, "pkg", "__init__.py"))).toBe(false); // discarded
  expect(headHas(wt, "checks/ENG-1_ac1_test.py")).toBe(false); // no poisoned check committed
  expect(checks).toHaveLength(0); // NO covered check persisted
  expect(message).toMatch(/import or collection error/);
  expect(message).toContain("pkg/__init__.py"); // shape-matched file surfaced (error named only 'pkg')
});

// --- A15 ⚔ (ENG-342 true-negative, CONTRAST for A14: a discarded __init__.py must NOT be blamed when
//            the error names an unrelated bare module) --------------------------------------------
// The check legitimately fails first because feature module `b` is absent (RED-first) — "No module
// named 'b'". The agent also left an UNDECLARED a/b/__init__.py (discarded). The package-init shape
// rule must NOT match: `b` is a bare interior segment of dir `a/b`, not the package `a.b`. So the guard
// does NOT fire → the AC stays COVERED and the RED is installed (the no-false-reject guarantee).
test("A15 ⚔ a discarded a/b/__init__.py + a fail-first 'No module named b' (unrelated) stays COVERED", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.py`),
        "from b import go\n\ndef test_x():\n    assert go()\n",
      );
      const abDir = join(cwd, "a", "b");
      mkdirSync(abDir, { recursive: true });
      writeFileSync(join(abDir, "__init__.py"), "y = 1\n"); // undeclared, discarded — must NOT be blamed
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, step, wt } = await driveChecks(h, runner, {
    runCheck: async () => ({
      exitCode: 2,
      stdout:
        "ImportError while importing test module\nE   ModuleNotFoundError: No module named 'b'",
      stderr: "",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(outcome.kind).toBe("stepped"); // NOT rejected
  expect(step?.status).toBe("succeeded");
  expect(existsSync(join(wt, "a", "b", "__init__.py"))).toBe(false); // still discarded
  expect(committedAtHead(wt)).toContain("_ac1_test.py"); // the RED check IS committed
  expect(checks).toHaveLength(1);
  expect(checks[0]?.red_first_result).toBe("red"); // installed as RED (classify judges absence later)
});

// --- A16 ⚔ (ENG-342: a discarded conftest.py whose absence names a FIXTURE, not the file →
//            shape-matched → uncovered → SURFACE) -------------------------------------------------
// The test uses a fixture that a discarded (undeclared) conftest.py provided → "fixture 'db' not found",
// which names the FIXTURE, never conftest.py. The conftest shape tier implicates the discarded
// conftest.py on the fixture/collection error → uncovered, file surfaced.
test("A16 ⚔ a discarded conftest.py named only via a missing fixture → AC uncovered, file surfaced", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ident}_ac${acId}_test.py`), "def test_x(db):\n    assert db\n");
      writeFileSync(
        join(dir, "conftest.py"),
        "import pytest\n\n@pytest.fixture\ndef db():\n    return 1\n",
      ); // undeclared → discarded
    },
    (acId, ident) => canonicalDeclared(acId, ident),
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner, {
    runCheck: async () => ({
      exitCode: 1,
      stdout: "E       fixture 'db' not found",
      stderr: "",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(existsSync(join(wt, "checks", "conftest.py"))).toBe(false); // discarded
  expect(checks).toHaveLength(0);
  expect(message).toMatch(/import or collection error/);
  expect(message).toContain("conftest.py"); // shape-matched file surfaced (error named only the fixture)
});

// --- A12 ⚔ (an undeclared source smuggle cannot fake a green) — CONTRAST PAIR --------------------
// With discard, an undeclared NEW source file can never smuggle a green: the guard discards it, so the
// `import smuggle` becomes an import-error RED naming the discarded file → the discard-poison guard
// routes it to uncovered → reject. Declaring the same file keeps it → the green is real → COMMIT.
test("A12 ⚔ an UNDECLARED source file that would fake a green is discarded → import-error RED → REJECT", async () => {
  // present → real green; absent (discarded before the run) → import-error RED naming `smuggle`.
  const greenIfSmuggle: Cmd = async (_cmd, opts) =>
    existsSync(join(opts.cwd, "smuggle.py"))
      ? { exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }
      : {
          exitCode: 2,
          stdout:
            "ImportError while importing test module\nE   ModuleNotFoundError: No module named 'smuggle'",
          stderr: "",
          timedOut: false,
        };

  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      canonicalTest(cwd, acId, ident, "import smuggle\n\ndef test_x():\n    assert smuggle.ok\n");
      writeFileSync(join(cwd, "smuggle.py"), "ok = True\n"); // UNDECLARED source smuggle
    },
    (acId, ident) => canonicalDeclared(acId, ident), // declares only the test
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner, { runCheck: greenIfSmuggle });
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind); // green defeated → uncovered → reject
  expect(step?.status).toBe("pending");
  expect(existsSync(join(wt, "smuggle.py"))).toBe(false); // stripped by the guard
  expect(headHas(wt, "smuggle.py")).toBe(false);
  expect(message).toContain("smuggle.py"); // the discarded smuggle is surfaced
});

test("A12 contrast: DECLARING that same source file keeps it → the green is now real → COMMIT", async () => {
  const greenIfSmuggle: Cmd = async (_cmd, opts) =>
    existsSync(join(opts.cwd, "smuggle.py"))
      ? { exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }
      : {
          exitCode: 2,
          stdout:
            "ImportError while importing test module\nE   ModuleNotFoundError: No module named 'smuggle'",
          stderr: "",
          timedOut: false,
        };

  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      canonicalTest(cwd, acId, ident, "import smuggle\n\ndef test_x():\n    assert smuggle.ok\n");
      writeFileSync(join(cwd, "smuggle.py"), "ok = True\n");
    },
    // now the source file IS declared in new_files → kept in scope, committed, run sees it → green.
    (acId, ident) => canonicalDeclared(acId, ident, { new_files: ["smuggle.py"] }),
  );
  const { outcome, wt } = await driveChecks(h, runner, { runCheck: greenIfSmuggle });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  // Outcomes DIFFER from the undeclared case solely on whether the guard discarded smuggle.py:
  expect(outcome.kind).toBe("stepped");
  expect(existsSync(join(wt, "smuggle.py"))).toBe(true);
  expect(checks[0]?.red_first_result).toBe("green"); // the green now survives (classify judges it later)
});

// ---------------------------------------------------------------------------------------------------
// B: checks re-author (checksScopeFor(ident,[acId]) + disposition "discard") — via runAgentDispatch
//    with the REAL scope factory + REAL disposition the re-author call site wires (handlers.ts ~252).
// ---------------------------------------------------------------------------------------------------

function rdCtx(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  stepKey: string,
): HandlerContext {
  const step = insertPending(db, { ticketId, stepKey, stepType: "dispatch" });
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  return { db, ticket, step, workUnitId: null, config: DEFAULT_RUNTIME_CONFIG };
}
function rdDeps(repo: string, wt: string) {
  return {
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({ slug: "demo", targetRepo: repo }),
    repoPath: repo,
    worktreePath: wt,
    branch: "feat/ENG-1",
    timeoutMs: 1000,
  };
}
function fakeApplyRunner(apply: (cwd: string) => void, stdout: string): FakeAgentRunner {
  return new FakeAgentRunner((input) => {
    apply(input.cwd);
    return {
      completed: true,
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      costUsd: 0,
      tokensIn: 1,
      tokensOut: 1,
    };
  });
}

test("B1 re-author commits a declared canonical test for the flagged AC", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-b1-${Date.now()}`);
  const runner = fakeApplyRunner(
    (cwd) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ENG-1_ac1_test.py"), "def test_x():\n    assert False\n");
    },
    canonicalDeclared(1, "ENG-1"),
  );
  const out = await runAgentDispatch(
    rdCtx(db, ticketId, "checks:reauthor"),
    { runner, ...rdDeps(repo, wt) },
    {
      handlerKey: "checks:dispatch",
      template: "t {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: checksScopeFor("ENG-1", [1]), // REAL scope the re-author wires
      disposition: "discard", // REAL disposition the re-author sets
      postcondition: () => {},
    },
  );
  db.close();
  expect(out.discarded).toEqual([]);
  expect(committedAtHead(wt)).toContain("ENG-1_ac1_test.py");
});

test("B2 ⚔ re-author discards an undeclared loose scratch (+note), no reject", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-b2-${Date.now()}`);
  const runner = fakeApplyRunner(
    (cwd) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "ENG-1_ac1_test.py"), "def test_x():\n    assert False\n");
      writeFileSync(join(cwd, "scratch.py"), "junk\n"); // undeclared loose
    },
    canonicalDeclared(1, "ENG-1"),
  );
  const out = await runAgentDispatch(
    rdCtx(db, ticketId, "checks:reauthor"),
    { runner, ...rdDeps(repo, wt) },
    {
      handlerKey: "checks:dispatch",
      template: "t {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: checksScopeFor("ENG-1", [1]),
      disposition: "discard",
      postcondition: () => {},
    },
  );
  const notes = listEvents(db, ticketId).filter((e) => e.reason?.startsWith("scope-discarded"));
  db.close();
  expect(out.discarded).toEqual(["scratch.py"]);
  expect(existsSync(join(wt, "scratch.py"))).toBe(false);
  expect(committedAtHead(wt)).toContain("ENG-1_ac1_test.py");
  expect(committedAtHead(wt)).not.toContain("scratch.py");
  expect(notes.length).toBe(1);
});

// ---------------------------------------------------------------------------------------------------
// C / D: the REAL implement:dispatch handler, resolved from the registry and invoked directly.
// ---------------------------------------------------------------------------------------------------

interface ImplHarness {
  db: ReturnType<typeof makeTestDb>["db"];
  ticketId: number;
  repo: string;
  wt: string;
  ctx: HandlerContext;
  handler: (ctx: HandlerContext) => unknown | Promise<unknown>;
  initialHead: string;
}

function setupImplement(opts?: {
  config?: RuntimeConfig;
  apply: (cwd: string) => void;
  stdout: string;
  repoExtra?: Record<string, string>;
  seedWorktree?: (wt: string) => void;
}): ImplHarness {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo(opts?.repoExtra);
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-sdsimpl-"));
  const wt = join(worktreeRoot, "ENG-1");
  const unit = insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "node",
    title: "impl unit",
    filesToTouch: ["src/feature.ts"],
    verifyCheckTypes: ["test"],
  });
  const runner = new FakeAgentRunner((input) => {
    opts?.apply(input.cwd);
    return {
      completed: true,
      exitCode: 0,
      stdout: opts?.stdout ?? "",
      stderr: "",
      timedOut: false,
      costUsd: 0,
      tokensIn: 1,
      tokensOut: 1,
    };
  });
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: nodeProfile(repo),
    worktreeRoot,
  });
  const handler = registry.resolve("implement:dispatch");
  if (!handler) throw new Error("no implement:dispatch handler");
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  const step = insertPending(db, {
    ticketId,
    stepKey: "implement:wu1:dispatch",
    stepType: "dispatch",
  });
  const ctx: HandlerContext = {
    db,
    ticket,
    step,
    workUnitId: unit.id,
    config: opts?.config ?? DEFAULT_RUNTIME_CONFIG,
  };
  // Create the worktree up front so a pre-existing-cruft seed lands in `untrackedBefore`.
  ensureWorktree(repo, branchNameFor(ticket), wt);
  opts?.seedWorktree?.(wt);
  const initialHead = git(repo, ["rev-parse", "HEAD"]);
  return { db, ticketId, repo, wt, ctx, handler, initialHead };
}

const discardConfig: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG, implementDisposition: "discard" };

// --- C: default reject mode ---------------------------------------------------------------------
test("C1 implement commits a declared new file", async () => {
  const h = setupImplement({
    apply: (cwd) => writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n"),
    stdout: sidecar({ new_files: ["x.ts"] }),
  });
  await h.handler(h.ctx);
  h.db.close();
  expect(committedAtHead(h.wt)).toContain("x.ts");
});

test("C2 ⚔ an undeclared loose junk.ts is REJECTED (out-of-scope files)", async () => {
  const h = setupImplement({
    apply: (cwd) => writeFileSync(join(cwd, "junk.ts"), "junk\n"),
    stdout: sidecar({ new_files: [] }),
  });
  await expect(h.handler(h.ctx)).rejects.toThrow(/out-of-scope files/);
  expect(git(h.wt, ["rev-parse", "HEAD"])).toBe(h.initialHead); // HEAD unchanged
  expect(existsSync(join(h.wt, "junk.ts"))).toBe(false); // attempt undone
  expect(listDispatches(h.db, h.ticketId).some((d) => d.outcome === "dispatch-failed")).toBe(true);
  h.db.close();
});

test("C3 implement commits an in-scope tracked edit", async () => {
  const h = setupImplement({
    apply: (cwd) => writeFileSync(join(cwd, "README.md"), "edited\n"),
    stdout: sidecar({ new_files: [] }),
  });
  await h.handler(h.ctx);
  h.db.close();
  expect(committedAtHead(h.wt)).toContain("README.md");
});

test("C4 a pure edit with an ABSENT sidecar commits (absent is legit for implement)", async () => {
  const h = setupImplement({
    apply: (cwd) => writeFileSync(join(cwd, "README.md"), "edited\n"),
    stdout: "no sidecar here",
  });
  await h.handler(h.ctx);
  h.db.close();
  expect(committedAtHead(h.wt)).toContain("README.md");
});

test("C5 ⚔ an undeclared new file with an ABSENT sidecar is REJECTED (reject mode)", async () => {
  const h = setupImplement({
    apply: (cwd) => writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n"),
    stdout: "no sidecar",
  });
  await expect(h.handler(h.ctx)).rejects.toThrow(/out-of-scope files/);
  expect(git(h.wt, ["rev-parse", "HEAD"])).toBe(h.initialHead);
  expect(existsSync(join(h.wt, "x.ts"))).toBe(false);
  h.db.close();
});

test("C6 ⚔ an edit + a new file with a MALFORMED block is REJECTED (reject mode, unchanged)", async () => {
  const h = setupImplement({
    apply: (cwd) => {
      writeFileSync(join(cwd, "README.md"), "edited\n");
      writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n");
    },
    stdout: "```styre-sidecar\n{ not json\n```",
  });
  await expect(h.handler(h.ctx)).rejects.toThrow(/out-of-scope files/);
  expect(git(h.wt, ["rev-parse", "HEAD"])).toBe(h.initialHead); // nothing committed
  expect(existsSync(join(h.wt, "x.ts"))).toBe(false);
  h.db.close();
});

test("C7 a styre_scratch/ drawer is swept, the declared fix commits", async () => {
  const h = setupImplement({
    apply: (cwd) => {
      writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n");
      mkdirSync(join(cwd, "styre_scratch"), { recursive: true });
      writeFileSync(join(cwd, "styre_scratch", "dbg.ts"), "scratch\n");
    },
    stdout: sidecar({ new_files: ["x.ts"] }),
  });
  await h.handler(h.ctx);
  h.db.close();
  expect(existsSync(join(h.wt, "styre_scratch"))).toBe(false);
  const committed = committedAtHead(h.wt);
  expect(committed).toContain("x.ts");
  expect(committed).not.toContain("dbg.ts");
});

// --- D: implementDisposition = "discard" --------------------------------------------------------
test("D1 discard-mode commits the declared new + DISCARDS an undeclared loose junk (+note)", async () => {
  const h = setupImplement({
    config: discardConfig,
    apply: (cwd) => {
      writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n");
      writeFileSync(join(cwd, "junk.ts"), "junk\n");
    },
    stdout: sidecar({ new_files: ["x.ts"] }),
  });
  await h.handler(h.ctx);
  const notes = listEvents(h.db, h.ticketId).filter((e) => e.reason?.startsWith("scope-discarded"));
  h.db.close();
  const committed = committedAtHead(h.wt);
  expect(committed).toContain("x.ts");
  expect(committed).not.toContain("junk.ts");
  expect(existsSync(join(h.wt, "junk.ts"))).toBe(false);
  expect(notes.length).toBe(1);
  expect(JSON.parse(notes[0]?.payload_json ?? "{}").discarded).toEqual(["junk.ts"]); // G3
});

test("D2 ⚔ discard-mode with an undeclared new + ABSENT sidecar RE-DISPATCHES; egg-info spared, no false revert", async () => {
  const h = setupImplement({
    config: discardConfig,
    apply: (cwd) => writeFileSync(join(cwd, "x.ts"), "export const x = 1;\n"),
    stdout: "no sidecar",
    seedWorktree: (wt) => {
      mkdirSync(join(wt, "pkg.egg-info"), { recursive: true });
      writeFileSync(join(wt, "pkg.egg-info", "PKG-INFO"), "meta\n");
    },
  });
  await expect(h.handler(h.ctx)).rejects.toThrow(/transport failure/);
  expect(existsSync(join(h.wt, "x.ts"))).toBe(false); // undeclared new was discarded
  expect(existsSync(join(h.wt, "pkg.egg-info", "PKG-INFO"))).toBe(true); // pre-existing cruft SPARED
  expect(git(h.wt, ["rev-parse", "HEAD"])).toBe(h.initialHead); // nothing committed
  // Nothing committed → the guard does NOT reset/mark reverted (guarded on sha !== preHead).
  expect(listDispatches(h.db, h.ticketId).some((d) => d.outcome === "reverted")).toBe(false);
  h.db.close();
});

test("D3 ⚔ discard-mode with an edit + MALFORMED block RE-DISPATCHES: HEAD reset to preHead, row reverted", async () => {
  const h = setupImplement({
    config: discardConfig,
    apply: (cwd) => writeFileSync(join(cwd, "README.md"), "edited\n"),
    stdout: "```styre-sidecar\n{ not json\n```",
  });
  await expect(h.handler(h.ctx)).rejects.toThrow(/transport failure/);
  expect(git(h.wt, ["rev-parse", "HEAD"])).toBe(h.initialHead); // committed edit rolled back
  expect(listDispatches(h.db, h.ticketId).some((d) => d.outcome === "reverted")).toBe(true);
  h.db.close();
});

test("D4 ⚔ discard-mode with an undeclared new + tracked deletion is REJECTED (rename-safety)", async () => {
  const h = setupImplement({
    config: discardConfig,
    apply: (cwd) => {
      rmSync(join(cwd, "README.md"));
      writeFileSync(join(cwd, "moved.ts"), "content\n");
    },
    stdout: sidecar({ new_files: [] }),
  });
  await expect(h.handler(h.ctx)).rejects.toThrow(/out-of-scope files.*(deletion|possible move)/);
  expect(git(h.wt, ["rev-parse", "HEAD"])).toBe(h.initialHead);
  expect(existsSync(join(h.wt, "moved.ts"))).toBe(false);
  expect(listDispatches(h.db, h.ticketId).some((d) => d.outcome === "dispatch-failed")).toBe(true);
  h.db.close();
});

test("D5 discard-mode: a pure edit with no new files + no sidecar COMMITS (no re-dispatch)", async () => {
  const h = setupImplement({
    config: discardConfig,
    apply: (cwd) => writeFileSync(join(cwd, "README.md"), "edited\n"),
    stdout: "no sidecar",
  });
  await h.handler(h.ctx); // must NOT throw
  h.db.close();
  expect(committedAtHead(h.wt)).toContain("README.md");
});

// ---------------------------------------------------------------------------------------------------
// E: design:dispatch (planScope, disposition unset → reject) — runAgentDispatch with the REAL planScope.
// F: docs:revise (docScope, unset → reject) — runAgentDispatch with the REAL docScope.
// ---------------------------------------------------------------------------------------------------

async function runPathScope(opts: {
  scope: typeof planScope;
  apply: (cwd: string) => void;
  stdout?: string;
  repoExtra?: Record<string, string>;
}) {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo(opts.repoExtra);
  const wt = join(repo, "..", `wt-ps-${Math.random().toString(36).slice(2)}`);
  const runner = fakeApplyRunner(opts.apply, opts.stdout ?? "no sidecar");
  const promise = runAgentDispatch(
    rdCtx(db, ticketId, "design:dispatch"),
    { runner, ...rdDeps(repo, wt) },
    {
      handlerKey: "design:dispatch",
      template: "t {{ident}}",
      vars: { ident: "ENG-1" },
      commitScope: opts.scope,
      // disposition unset → reject (the default plan/docs steps wire)
      postcondition: () => {},
    },
  );
  return { db, ticketId, wt, promise };
}

test("E1 plan commits a file under docs/plans/", async () => {
  const { db, wt, promise } = await runPathScope({
    scope: planScope,
    apply: (cwd) => {
      mkdirSync(join(cwd, "docs", "plans"), { recursive: true });
      writeFileSync(join(cwd, "docs", "plans", "ENG-1-plan.md"), "# plan\n");
    },
  });
  await promise;
  db.close();
  expect(committedAtHead(wt)).toContain("docs/plans/ENG-1-plan.md");
});

test("E2 ⚔ plan REJECTS a new file outside docs/plans/", async () => {
  const { db, wt, promise } = await runPathScope({
    scope: planScope,
    apply: (cwd) => {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "x.ts"), "export const x = 1;\n");
    },
  });
  await expect(promise).rejects.toThrow(/out-of-scope files/);
  expect(existsSync(join(wt, "src", "x.ts"))).toBe(false);
  db.close();
});

test("E3 ⚔ plan REJECTS an out-of-scope tracked edit", async () => {
  const { db, promise } = await runPathScope({
    scope: planScope,
    repoExtra: { "src/app.ts": "export const a = 1;\n" },
    apply: (cwd) => writeFileSync(join(cwd, "src", "app.ts"), "export const a = 2;\n"),
  });
  await expect(promise).rejects.toThrow(/tracked edits outside this step's scope/);
  db.close();
});

test("F1 docs:revise commits a file under docs/", async () => {
  const { db, wt, promise } = await runPathScope({
    scope: docScope,
    apply: (cwd) => {
      mkdirSync(join(cwd, "docs"), { recursive: true });
      writeFileSync(join(cwd, "docs", "guide.md"), "# guide\n");
    },
  });
  await promise;
  db.close();
  expect(committedAtHead(wt)).toContain("docs/guide.md");
});

test("F2 ⚔ docs:revise REJECTS a new file outside docs/", async () => {
  const { db, wt, promise } = await runPathScope({
    scope: docScope,
    apply: (cwd) => {
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "src", "x.ts"), "export const x = 1;\n");
    },
  });
  await expect(promise).rejects.toThrow(/out-of-scope files/);
  expect(existsSync(join(wt, "src", "x.ts"))).toBe(false);
  db.close();
});

test("F3 ⚔ docs:revise REJECTS an out-of-scope tracked edit", async () => {
  const { db, promise } = await runPathScope({
    scope: docScope,
    repoExtra: { "src/app.ts": "export const a = 1;\n" },
    apply: (cwd) => writeFileSync(join(cwd, "src", "app.ts"), "export const a = 2;\n"),
  });
  await expect(promise).rejects.toThrow(/tracked edits outside this step's scope/);
  db.close();
});

// ---------------------------------------------------------------------------------------------------
// G: cross-cutting invariants
// ---------------------------------------------------------------------------------------------------

test("G1 ⚔ disposition omitted defaults to reject — CONTRAST with discard", async () => {
  // Same undeclared new file, same REAL implementScope; only the disposition differs.
  const scenario = (disposition?: "reject" | "discard") => {
    const { db, ticketId } = makeTestDb();
    const repo = gitRepo();
    const wt = join(repo, "..", `wt-g1-${Math.random().toString(36).slice(2)}`);
    const runner = fakeApplyRunner(
      (cwd) => writeFileSync(join(cwd, "junk.ts"), "junk\n"),
      sidecar({ new_files: [] }),
    );
    const promise = runAgentDispatch(
      rdCtx(db, ticketId, "implement:wu1:dispatch"),
      { runner, ...rdDeps(repo, wt) },
      {
        handlerKey: "implement:dispatch",
        template: "t {{ident}}",
        vars: { ident: "ENG-1" },
        commitScope: implementScope,
        disposition,
        postcondition: () => {},
      },
    );
    return { db, wt, promise };
  };

  const omitted = scenario(undefined); // omitted → reject
  await expect(omitted.promise).rejects.toThrow(/out-of-scope files/);
  omitted.db.close();

  const discard = scenario("discard"); // discard → proceeds, file discarded
  const out = await discard.promise;
  expect(out.discarded).toEqual(["junk.ts"]);
  expect(existsSync(join(discard.wt, "junk.ts"))).toBe(false);
  discard.db.close();
});

test("G2 a read-only dispatch (no commitScope) leaves a stray NOTED, not deleted, not rejected", async () => {
  const { db, ticketId } = makeTestDb();
  const repo = gitRepo();
  const wt = join(repo, "..", `wt-g2-${Date.now()}`);
  const runner = fakeApplyRunner((cwd) => writeFileSync(join(cwd, "stray.txt"), "oops\n"), "{}");
  await runAgentDispatch(
    rdCtx(db, ticketId, "review"),
    { runner, ...rdDeps(repo, wt) },
    {
      handlerKey: "review",
      template: "t {{ident}}",
      vars: { ident: "ENG-1" },
      postcondition: () => {},
    },
  ); // no commitScope → read-only
  expect(listDispatches(db, ticketId)[0]?.outcome).toBe("clean-success");
  expect(existsSync(join(wt, "stray.txt"))).toBe(true); // NOT deleted
  const notes = listEvents(db, ticketId).filter((e) => e.reason?.startsWith("scratch-ignored"));
  expect(notes.length).toBe(1);
  expect(JSON.parse(notes[0]?.payload_json ?? "{}").stray).toContain("stray.txt");
  db.close();
});

// G3 (note payload lists exactly the discarded paths) is asserted inside A4 and D1.

test("G4 ⚔ verify:check sweeps a styre_scratch/ present at verify time (before the suite)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-sdsverify-"));
  const wt = join(worktreeRoot, "ENG-1");
  const unit = insertWorkUnit(db, { ticketId, seq: 1, kind: "node", verifyCheckTypes: ["test"] });
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: nodeProfile(repo),
    worktreeRoot,
  });
  const handler = registry.resolve("verify:check");
  if (!handler) throw new Error("no verify:check handler");
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new Error("no ticket");
  const step = insertPending(db, { ticketId, stepKey: "verify:wu1:test", stepType: "verify" });
  // Create the worktree and drop a scratch drawer into it BEFORE verify runs.
  ensureWorktree(repo, branchNameFor(ticket), wt);
  mkdirSync(join(wt, "styre_scratch"), { recursive: true });
  writeFileSync(join(wt, "styre_scratch", "leftover.py"), "scratch\n");
  expect(existsSync(join(wt, "styre_scratch"))).toBe(true); // present before verify
  const ctx: HandlerContext = {
    db,
    ticket,
    step,
    workUnitId: unit.id,
    config: DEFAULT_RUNTIME_CONFIG,
  };
  // verify:check sweeps at entry (line ~1183) then throws on the empty diff — the sweep already ran.
  await expect(Promise.resolve(handler(ctx))).rejects.toThrow();
  expect(existsSync(join(wt, "styre_scratch"))).toBe(false); // swept before the suite
  db.close();
});

test("G5 reject feedback is a diagnosis: 'out-of-scope files', no delete/new_files instruction", async () => {
  // implement reject (undeclared new)
  let implMsg = "";
  {
    const h = setupImplement({
      apply: (cwd) => writeFileSync(join(cwd, "junk.ts"), "junk\n"),
      stdout: sidecar({ new_files: [] }),
    });
    try {
      await h.handler(h.ctx);
    } catch (e) {
      implMsg = (e as Error).message;
    }
    h.db.close();
  }
  // path-scope reject (plan, new file outside docs/plans)
  let planMsg = "";
  {
    const { db, promise } = await runPathScope({
      scope: planScope,
      apply: (cwd) => {
        mkdirSync(join(cwd, "src"), { recursive: true });
        writeFileSync(join(cwd, "src", "x.ts"), "x\n");
      },
    });
    try {
      await promise;
    } catch (e) {
      planMsg = (e as Error).message;
    }
    db.close();
  }
  for (const msg of [implMsg, planMsg]) {
    expect(msg).toMatch(/out-of-scope files/); // scope-neutral prefix
    expect(msg).not.toMatch(/\bdelete\b/i); // no imperative instruction
    expect(msg).not.toContain("new_files"); // no schema-key leakage into path-scope feedback
  }
  expect(implMsg).not.toBe("");
  expect(planMsg).not.toBe("");
});

// --- A17 ⚔ (ENG-343: a discarded Go helper package → guard fires through the REAL dispatch path) ---
// The canonical check imports package `example.com/m/helper`; the agent wrote helper/helper.go but did
// NOT declare it → discarded → `go test` cannot resolve the package. Proves the guard is reached, the
// file surfaced, AND the compiler's own line carried into the message, on a stack that is not Python.
test("A17 ⚔ a discarded Go helper package → AC uncovered, file surfaced", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.go`),
        'package checks\n\nimport "example.com/m/helper"\n\nfunc TestX(t *testing.T) { _ = helper.X }\n',
      );
      const pkgDir = join(cwd, "helper");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "helper.go"), "package helper\n\nvar X = 1\n"); // undeclared → discarded
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `checks/${ident}_ac${acId}_test.go`, test_name: "TestX" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner, {
    profile: goProfile(h.repo),
    // exit 1 with no "no tests to run" ⇒ interpretRunOutput → red ⇒ the guard runs.
    runCheck: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `checks/${h.ident}_ac1_test.go:3:8: no required module provides package example.com/m/helper; to add it:`,
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(existsSync(join(wt, "helper", "helper.go"))).toBe(false); // discarded
  expect(headHas(wt, "checks/ENG-1_ac1_test.go")).toBe(false); // no poisoned check committed
  expect(checks).toHaveLength(0);
  expect(message).toMatch(/import or collection error/);
  expect(message).toContain("helper/helper.go");
  // The framework-aware excerpt (design 4.5) carried a real Go compiler line into the feedback.
  expect(message).toContain("no required module provides package");
});

// --- A18 ⚔ (ENG-343 contrast for A17: a Go red that names a FEATURE package must stay covered) -----
// The check legitimately fails first because the feature package is absent. An UNRELATED throwaway was
// discarded. The guard must NOT fire: the AC stays covered and the RED is installed.
test("A18 ⚔ a Go red naming a FEATURE package + an unrelated discarded file stays COVERED", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.go`),
        'package checks\n\nimport "example.com/m/newfeature"\n\nfunc TestX(t *testing.T) { _ = newfeature.X }\n',
      );
      const scratch = join(cwd, "scratch");
      mkdirSync(scratch, { recursive: true });
      writeFileSync(join(scratch, "scratch.go"), "package scratch\n"); // undeclared, unrelated
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `checks/${ident}_ac${acId}_test.go`, test_name: "TestX" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, step, wt } = await driveChecks(h, runner, {
    profile: goProfile(h.repo),
    runCheck: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `checks/${h.ident}_ac1_test.go:3:8: no required module provides package example.com/m/newfeature; to add it:`,
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(outcome.kind).toBe("stepped"); // NOT rejected
  expect(step?.status).toBe("succeeded");
  expect(existsSync(join(wt, "scratch", "scratch.go"))).toBe(false); // still discarded
  expect(committedAtHead(wt)).toContain("_ac1_test.go"); // the RED check IS committed
  expect(checks).toHaveLength(1);
  expect(checks[0]?.red_first_result).toBe("red");
});

// --- A19 (ENG-343 residual pin: rspec load errors never reach the guard) ------------------------
// RSpec does NOT abort on a spec-file load error — it reports it and still prints `0 examples`,
// exiting 1. interpretRunOutput's `case "rspec"` tests `\b0 examples` BEFORE the exit code, so the run
// is bucketed `selected-none` and handlers.ts `continue`s the per-AC loop ABOVE the discard-poison
// guard — the guard is never consulted.
// This is SAFE (the AC still goes uncovered and discardNote still names the file) but the specific
// "could not be collected" message is never produced.
//
// IF THIS TEST GOES RED: someone changed the rspec branch of interpretRunOutput so load errors now
// bucket as `red`. That is an IMPROVEMENT, not a regression — update this cell and design section 6
// to the new behaviour. Do NOT revert the interpretRunOutput change to get green.
test("A19 an rspec load error is bucketed selected-none, bypassing the discard-poison guard", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "spec");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.rb`),
        "require 'support/helper'\n\nRSpec.describe 'x' do\n  it 'works' do\n    expect(Helper.x).to be true\n  end\nend\n",
      );
      const sup = join(cwd, "spec", "support");
      mkdirSync(sup, { recursive: true });
      writeFileSync(join(sup, "helper.rb"), "module Helper; def self.x; true; end; end\n");
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `spec/${ident}_ac${acId}_test.rb`, test_name: "works" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, step, message } = await driveChecks(h, runner, {
    profile: rubyProfile(h.repo),
    // REAL rspec output for a load error — including the `0 examples` summary it always prints.
    runCheck: async () => ({
      exitCode: 1,
      stdout:
        "An error occurred while loading ./spec/ENG-1_ac1_test.rb.\n" +
        "Failure/Error: require 'support/helper'\n\n" +
        "LoadError:\n  cannot load such file -- support/helper\n\n" +
        "0 examples, 0 failures, 1 error occurred outside of examples",
      stderr: "",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(checks).toHaveLength(0); // still safe: no poisoned check installed
  expect(message).toMatch(/matched no test/); // the selected-none reason, NOT the guard's message
  expect(message).not.toMatch(/import or collection error/); // the guard did not run
  expect(message).toContain("spec/support/helper.rb"); // discardNote still names the file
});

// --- A20 ⚔ (ENG-343 design 4.5: a Go helper in the SAME package, tied by symbol evidence) --------
// The compiler reports `undefined: Help` — it names the FUNCTION, never the file, which is already
// deleted. No phrase can tie this. The guard implicates the discarded file because that file's
// captured contents DEFINED `Help`. This cell is the only proof that the contents survive from
// discardPaths' call site all the way to the guard.
test("A20 ⚔ a discarded same-package Go helper is tied by the symbol it defined", async () => {
  const h = await setupChecks("- [ ] one thing\n");
  const runner = checksRunner(
    h,
    (cwd, acId, ident) => {
      const dir = join(cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${ident}_ac${acId}_test.go`),
        "package checks\n\nfunc TestX(t *testing.T) { _ = Help() }\n",
      );
      // Same package, undeclared → discarded. Its NAME never appears in the compiler output.
      writeFileSync(join(dir, "helper.go"), "package checks\n\nfunc Help() int { return 1 }\n");
    },
    (acId, ident) =>
      `\`\`\`styre-sidecar\n${JSON.stringify({
        checksAuthored: [
          { ac_id: acId, test_file: `checks/${ident}_ac${acId}_test.go`, test_name: "TestX" },
        ],
      })}\n\`\`\``,
  );
  const { outcome, step, wt, message } = await driveChecks(h, runner, {
    profile: goProfile(h.repo),
    runCheck: async () => ({
      exitCode: 1,
      stdout: "",
      // Note: names the SYMBOL only. `helper.go` appears nowhere.
      stderr: "checks/ENG-1_ac1_test.go:3:30: undefined: Help",
      timedOut: false,
    }),
  });
  const checks = listAcChecks(h.db, h.ticketId);
  h.db.close();
  expect(["retry", "escalated"]).toContain(outcome.kind);
  expect(step?.status).toBe("pending");
  expect(existsSync(join(wt, "checks", "helper.go"))).toBe(false); // discarded
  expect(checks).toHaveLength(0); // no poisoned check installed
  expect(message).toMatch(/import or collection error/);
  expect(message).toContain("checks/helper.go"); // tied by evidence, not by name
  expect(message).toContain("undefined: Help"); // the excerpt carried the compiler's own line
});
