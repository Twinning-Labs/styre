// test/cli/checkpoint-readers-fixtures.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { listCheckpoints } from "../../src/cli/checkpoints.ts";
import { cleanImpl, styreWorktreeCandidates } from "../../src/cli/clean.ts";
import type { StyreError } from "../../src/cli/errors.ts";
import { loadRunProfile } from "../../src/cli/load-profile.ts";
import { lsImpl } from "../../src/cli/ls.ts";
import { renderError } from "../../src/cli/output.ts";
import { type ResumeArgs, parkDir, resumeRun } from "../../src/cli/park.ts";
import { runSetup, setupImpl } from "../../src/cli/setup.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { migrate } from "../../src/db/migrate.ts";
import { CURRENT_VERSION } from "../../src/db/migrations/index.ts";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { listCheckpointRunningSteps } from "../../src/db/repos/checkpoint-read.ts";
import { type Profile, parseProfile } from "../../src/dispatch/profile.ts";
import { undoBeforeDiscard } from "../../src/util/process/interruption.ts";
import { FIXTURES, copyFixture, fixtureVersion } from "../helpers/db-fixtures.ts";
import { type FreshTicketRun, runFreshTicket } from "../helpers/run-harness.ts";
import { makeTempDir, trackTempEntriesMadeBy } from "../helpers/temp.ts";

/** These tests run git and whole `styre run` invocations: a time limit of their own. */
const TIMEOUT_MS = 60_000;

let stderr: string[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  stderr = [];
  spy = spyOn(process.stderr, "write").mockImplementation((c: unknown) => {
    stderr.push(String(c));
    return true;
  });
});
afterEach(() => spy.mockRestore());

/** `fn` with the environment variable `name` set to `value`, restored afterwards. */
async function withEnv<T>(name: string, value: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = prev;
  }
}

/** What `fn` writes to stdout. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
    out.push(String(c));
    return true;
  });
  try {
    await fn();
  } finally {
    stdout.mockRestore();
  }
  return out.join("");
}

/** git in `cwd`, with a time limit; the test fails on a git error. Returns stdout. */
function gitIn(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** A repository with one commit at `path`: the one repository builder of this file. */
function repoAt(path: string): string {
  mkdirSync(path, { recursive: true });
  gitIn(path, ["init", "-q", "-b", "main"]);
  gitIn(path, ["config", "user.email", "t@s.dev"]);
  gitIn(path, ["config", "user.name", "T"]);
  writeFileSync(join(path, "README.md"), "x");
  gitIn(path, ["add", "-A"]);
  gitIn(path, ["commit", "-q", "-m", "init"]);
  return path;
}

const gitRepo = (): string => repoAt(makeTempDir("styre-readers-repo-"));

/** `resumeRun` with `--inspect`: the agent CLI preflight injected and any worktree root it leaves
 *  tracked, so a regression past the inspect block can reach neither the real CLI nor a leak. */
function inspectResume(args: ResumeArgs, profile: Profile): Promise<void> {
  return trackTempEntriesMadeBy("styre-wt-", () =>
    resumeRun({ ...args, inspect: true }, profile, DEFAULT_RUNTIME_CONFIG, {
      preflight: () => ({ ok: true, version: null }),
    }),
  );
}

/** <root>/<slug>/ENG-1/run.db holding a private copy of the fixture. */
function checkpointOf(
  name: (typeof FIXTURES)[number],
  slug: string,
): { root: string; dbPath: string } {
  const root = makeTempDir("styre-readers-state-");
  const dir = join(root, slug, "ENG-1");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "run.db");
  copyFileSync(copyFixture(name), dbPath);
  return { root, dbPath };
}

describe("checkpoints are read without migrating them (spec §7.7)", () => {
  for (const name of FIXTURES) {
    test(`${name}: the narrow running step read works on the old shape`, () => {
      const path = copyFixture(name);
      const keys = readCopyOf(path, (db) => listCheckpointRunningSteps(db).map((s) => s.step_key));
      expect(keys).toEqual(name === "v6-v0.7.0" ? [] : ["implement:wu1:dispatch"]);
    });

    test(`${name}: ls lists it and leaves its version alone`, () => {
      const { root, dbPath } = checkpointOf(name, "fixture");
      const before = fixtureVersion(dbPath);
      const found = listCheckpoints(root);
      // classified, not listed as unreadable: every reader worked on this shape (v6 is refused by
      // its schema, before any reader runs)
      expect(found.map((c) => [c.ident, c.kind, c.note])).toEqual([
        name === "v6-v0.7.0"
          ? ["ENG-1", "incompatible", "older than v7 (schema v6)"]
          : ["ENG-1", "needs_you", "fixture pause"],
      ]);
      expect(fixtureVersion(dbPath)).toBe(before);
    });

    test(`${name}: --fresh's discard reads it without migrating`, () => {
      const { dbPath } = checkpointOf(name, "fixture");
      const before = fixtureVersion(dbPath);
      const lines: string[] = [];
      undoBeforeDiscard(dbPath, (l) => lines.push(l));
      expect(lines.join("\n")).not.toContain("could not read");
      // The recorded worktree of every fixture is gone, so the undo is reached and skipped, which
      // proves the interruption, the ticket and the project were all read; v6 has no running step.
      expect(lines).toEqual(
        name === "v6-v0.7.0"
          ? []
          : [
              "styre: skipped undoing the interrupted step's edits: /nonexistent/styre-fixture-repo no longer exists",
            ],
      );
      expect(fixtureVersion(dbPath)).toBe(before);
    });

    test(
      `${name}: clean reaps it (v6: refuses it, a schema this Styre cannot use)`,
      async () => {
        const { root, dbPath } = checkpointOf(name, "fixture");
        // `root` is the state root: cleanImpl reads <root>/<slug>/<ident>.
        const done = await cleanImpl(
          { ident: "ENG-1", slug: "fixture" },
          { root, targetRepo: gitRepo() },
        ).catch((e: unknown) => e);
        if (name === "v6-v0.7.0") {
          expect((done as { code?: number }).code).toBe(65);
          expect(existsSync(dbPath)).toBe(true);
        } else {
          expect(done).toBeUndefined();
          expect(existsSync(dbPath)).toBe(false);
        }
        expect(stderr.join("")).not.toContain("could not read");
      },
      TIMEOUT_MS,
    );

    test(
      `${name}: styre run --fresh discards it and starts over`,
      async () => {
        const state = makeTempDir("styre-readers-fresh-");
        const dir = join(state, "styre", "test-project", "ENG-1");
        mkdirSync(dir, { recursive: true });
        copyFileSync(copyFixture(name), join(dir, "run.db"));
        const run = await runFreshTicket({
          fresh: true,
          reuseStateOf: { stateRoot: state } as FreshTicketRun,
        });
        try {
          expect(fixtureVersion(run.dbPath)).toBeGreaterThanOrEqual(8); // a new checkpoint
          expect(stderr.join("")).not.toContain("could not read");
        } finally {
          run.cleanup();
        }
      },
      TIMEOUT_MS,
    );

    test(
      `${name}: --resume --inspect reports it and writes nothing`,
      async () => {
        // operator rulings, 2026-10-09 and 2026-10-10: no migration, no backup, no run row, also
        // where resume would refuse
        const state = makeTempDir("styre-readers-inspect-");
        const dir = join(state, "styre", "inspect", "ENG-1"); // parkDir("inspect", "ENG-1")
        mkdirSync(dir, { recursive: true });
        const dbPath = join(dir, "run.db");
        copyFileSync(copyFixture(name), dbPath);
        const before = fixtureVersion(dbPath);
        const bytes = readFileSync(dbPath);
        const profile = parseProfile({ slug: "inspect", targetRepo: gitRepo(), components: [] });
        await withEnv("XDG_STATE_HOME", state, () => inspectResume({ resume: "ENG-1" }, profile));
        const out = stderr.join("");
        const expected =
          before < 7
            ? "resume would refuse this checkpoint"
            : before === CURRENT_VERSION
              ? "would re-dispatch step"
              : `resume will upgrade this checkpoint from v${before} to v${CURRENT_VERSION}, after writing a backup`;
        expect(out).toContain(expected);
        // the details are read on every shape too, with the readers that work since v7
        expect(out).toContain(
          `would re-dispatch step: ${name === "v6-v0.7.0" ? "(none)" : "implement:wu1:dispatch"}`,
        );
        expect(fixtureVersion(dbPath)).toBe(before);
        // read only whatever the version (operator ruling, 2026-10-10): the same bytes, no backup,
        // no -wal or -shm made beside it, so no run row was written and the original never opened
        expect(readFileSync(dbPath).equals(bytes)).toBe(true);
        expect(readdirSync(dir).sort()).toEqual(["run.db"]);
      },
      TIMEOUT_MS,
    );
  }
});

/** A checkpoint in WAL mode with no -wal or -shm beside it, as when run.db is copied alone. */
function walCheckpointAlone(): { root: string; dbPath: string } {
  const made = checkpointOf("v8-main-2b05680", "fixture");
  // openDb leaves the file in WAL mode. On macOS (observed with Bun 1.4.2) the -wal and -shm stay
  // after close; elsewhere SQLite may remove them. Either way this removes them itself, and the
  // private copy relies on neither.
  migrate(made.dbPath);
  const fold = new Database(made.dbPath);
  fold.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  fold.close();
  for (const ext of ["-wal", "-shm"]) rmSync(`${made.dbPath}${ext}`, { force: true });
  return made;
}

test("a WAL checkpoint without -wal or -shm beside it is read through a private copy and left as it was", () => {
  // operator ruling, 2026-10-09: a read only open of such a file fails on macOS; a private copy reads it
  const { root, dbPath } = walCheckpointAlone();
  const dir = dirname(dbPath);
  const files = () =>
    readdirSync(dir)
      .sort()
      .map((f) => [f, readFileSync(join(dir, f)).toString("base64")]);
  const before = files();
  expect(listCheckpoints(root).map((c) => [c.ident, c.kind])).toEqual([["ENG-1", "needs_you"]]);
  const lines: string[] = [];
  undoBeforeDiscard(dbPath, (l) => lines.push(l));
  expect(lines.join("\n")).not.toContain("could not read");
  expect(files()).toEqual(before);
});

test(
  "clean reaps a WAL checkpoint without -wal or -shm beside it: its reads go through a private copy too",
  async () => {
    const { root, dbPath } = walCheckpointAlone();
    const done = await cleanImpl(
      { ident: "ENG-1", slug: "fixture" },
      { root, targetRepo: gitRepo() },
    ).catch((e: unknown) => e);
    expect(done).toBeUndefined();
    expect(existsSync(dirname(dbPath))).toBe(false);
    expect(stderr.join("")).not.toContain("could not read");
  },
  TIMEOUT_MS,
);

test("ls lists an effort it cannot read as unreadable, with the reason, instead of dropping it", async () => {
  const root = makeTempDir("styre-readers-state-");
  mkdirSync(join(root, "fixture", "ENG-9"), { recursive: true });
  writeFileSync(join(root, "fixture", "ENG-9", "run.db"), "not a database");
  const found = listCheckpoints(root);
  expect(found.map((c) => [c.ident, c.kind, c.resumable])).toEqual([
    ["ENG-9", "unreadable", false],
  ]);
  expect(found[0]?.note).toContain("could not read it");
  const out = await captureStdout(() => lsImpl({ root, swept: [] }));
  expect(out).toContain("Unreadable checkpoints (remove by hand:");
  expect(out).toContain("fixture/ENG-9  could not read it:");
});

/** A checkpoint folder `<root>/fixture/<ident>` whose run.db is not a database. The state root's
 *  name holds a single quote: a path is printed as it is, as plain text. */
function unreadableEffort(
  ident: string,
  prefix = "styre-readers-state-o'q-",
): { root: string; dir: string } {
  const root = makeTempDir(prefix);
  const dir = join(root, "fixture", ident);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.db"), "not a database");
  return { root, dir };
}

/** The lock of a run that is alive: this test's parent process, which outlives the test. */
const lockByLiveRun = (dir: string) => writeFileSync(join(dir, "run.lock"), String(process.ppid));

test("ls lists a checkpoint whose ticket table is empty as unreadable, and says when it is running", async () => {
  const root = makeTempDir("styre-readers-state-");
  const dir = join(root, "fixture", "ENG-8");
  mkdirSync(dir, { recursive: true });
  migrate(join(dir, "run.db")); // tables, no ticket
  lockByLiveRun(dir);
  const found = listCheckpoints(root);
  expect(found.map((c) => [c.ident, c.kind, c.note, c.live])).toEqual([
    ["ENG-8", "unreadable", "no ticket recorded", true],
  ]);
  const out = await captureStdout(() => lsImpl({ root, swept: [] }));
  expect(out).toContain("fixture/ENG-8 (running)  no ticket recorded");
  expect(out).not.toContain("Running:");
});

/** Every file under `root` with its bytes: what a refusal must leave exactly as it was. */
const treeOf = (root: string) =>
  (readdirSync(root, { recursive: true }) as string[]).sort().map((f) => {
    const full = join(root, f);
    return [f, statSync(full).isDirectory() ? "dir" : readFileSync(full).toString("base64")];
  });

test(
  "clean refuses an unreadable effort (exit 65), removes nothing, and lists exactly the worktrees that look like its own",
  async () => {
    const { root, dir } = unreadableEffort("ENG-9");
    // The repository itself has the shape of a candidate (<styre-wt-*>/ENG-9): it is the main
    // entry and never listed. The paths hold a single quote; they are printed as plain text.
    const repo = repoAt(join(makeTempDir("styre-wt-o'q-"), "ENG-9"));
    const add = (path: string, branch: string) => {
      gitIn(repo, ["worktree", "add", "-q", "-b", branch, path]);
      return realpathSync(path); // git reports real paths
    };
    const mine = add(join(makeTempDir("styre-wt-o'q-"), "ENG-9"), "feat/ENG-9");
    const nested = add(join(makeTempDir("styre-wt-"), "sub", "ENG-9"), "nested"); // parent is "sub"
    const elsewhere = add(join(makeTempDir("scratch-"), "ENG-9"), "elsewhere");
    const otherIdent = add(join(makeTempDir("styre-wt-"), "ENG-7"), "feat/ENG-7");
    expect(styreWorktreeCandidates(repo, "ENG-9")).toEqual([mine]);
    // asked from a linked worktree, that worktree is the repository itself and is not listed
    expect(styreWorktreeCandidates(mine, "ENG-9")).toEqual([]);
    const before = treeOf(root);

    const refusal = await cleanImpl(
      { ident: "ENG-9", slug: "fixture" },
      { root, targetRepo: repo },
    ).catch((e: unknown) => e);
    const e = refusal as { code?: number; headline?: string; detail?: string; recovery?: string };
    expect(e.code).toBe(65);
    expect(e.headline).toContain("cannot clean 'ENG-9'");
    const detail = String(e.detail);
    expect(detail).toContain(`checkpoint folder: ${dir}`);
    // the worktrees that look like the run's, as plain paths: exactly `mine`, never the
    // repository itself nor a worktree of another shape
    expect(detail.split("\n").filter((l) => l.startsWith("  "))).toEqual([`  ${mine}`]);
    for (const wt of [nested, elsewhere, otherIdent]) expect(detail).not.toContain(wt);
    expect(e.recovery).toBe(
      "Nothing was removed. To remove the run by hand, see the `styre clean` section of docs/architecture/runtime-parameters.md.",
    );
    // no shell command is printed (operator ruling, 2026-10-10; printed commands are ENG-491)
    const shown = renderError("clean", refusal as StyreError);
    for (const command of ["rm -r", "worktree remove", "--fresh", "--force"]) {
      expect(shown).not.toContain(command);
    }
    // nothing removed: the checkpoint, every worktree and the repository are as they were
    expect(treeOf(root)).toEqual(before);
    for (const wt of [mine, nested, elsewhere, otherIdent]) expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(repo, "README.md"))).toBe(true);
  },
  TIMEOUT_MS,
);

test(
  "clean refuses an unreadable effort with --purge too (65), a live one at the gate (75), and says when no worktree looks like its own",
  async () => {
    const idle = unreadableEffort("ENG-9");
    const repo = gitRepo();
    // the ticket branch, locally and on a remote (a bare repository on disk): --purge would delete
    // both, so the refusal must leave both as they are
    const remote = makeTempDir("styre-readers-remote-");
    gitIn(remote, ["init", "-q", "--bare"]);
    gitIn(repo, ["branch", "feat/ENG-9"]);
    gitIn(repo, ["remote", "add", "origin", remote]);
    gitIn(repo, ["push", "-q", "origin", "feat/ENG-9"]);
    const refs = () => [gitIn(repo, ["for-each-ref"]), gitIn(remote, ["for-each-ref"])];
    const refsBefore = refs();
    expect(refsBefore.join("")).toContain("refs/heads/feat/ENG-9");
    const purge = await cleanImpl(
      { ident: "ENG-9", slug: "fixture", purge: true },
      { root: idle.root, targetRepo: repo },
    ).catch((e: unknown) => e);
    expect((purge as { code?: number }).code).toBe(65);
    expect(String((purge as { detail?: string }).detail)).toContain(
      `no worktree of ${repo} looks like this run's`,
    );
    expect(existsSync(idle.dir)).toBe(true);
    expect(refs()).toEqual(refsBefore);

    const live = unreadableEffort("ENG-9");
    lockByLiveRun(live.dir);
    const refusal = await cleanImpl(
      { ident: "ENG-9", slug: "fixture" },
      { root: live.root, targetRepo: repo },
    ).catch((e: unknown) => e);
    expect((refusal as { code?: number }).code).toBe(75);
    expect(existsSync(live.dir)).toBe(true);
  },
  TIMEOUT_MS,
);

test(
  "a checkpoint folder without run.db is not an effort: ls skips it, clean says so (64)",
  async () => {
    const root = makeTempDir("styre-readers-state-");
    const bare = join(root, "fixture", "ENG-6");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, "transcript.json"), "{}");
    expect(listCheckpoints(root)).toEqual([]);
    const refusal = await cleanImpl(
      { ident: "ENG-6", slug: "fixture" },
      { root, targetRepo: gitRepo() },
    ).catch((e: unknown) => e);
    expect((refusal as { code?: number }).code).toBe(64);
    expect(existsSync(join(bare, "transcript.json"))).toBe(true);
  },
  TIMEOUT_MS,
);

/** A checkpoint whose schema this Styre refuses, built on a private copy of a fixture. */
const INCOMPATIBLE: { reason: string; shape?: string; make: () => string }[] = [
  {
    reason: "written by a newer Styre (schema v99)",
    make: () => {
      const path = copyFixture("v8-main-2b05680");
      const db = new Database(path);
      // A direct write (ruling M18): no real step makes a schema newer than this binary's.
      db.query(
        "INSERT INTO schema_meta (version, applied_at, note) VALUES (99, 't', 'future')",
      ).run();
      db.close();
      return path;
    },
  },
  {
    reason: "unknown database shape",
    make: () => {
      const path = copyFixture("v7-v0.10.0");
      const db = new Database(path);
      // A direct write (ruling M18): no real step makes a shape no release had.
      db.exec("ALTER TABLE ticket ADD COLUMN surprise TEXT");
      db.close();
      return path;
    },
  },
  {
    reason: "unknown database shape",
    shape: "with tables but no schema_meta",
    make: () => {
      const path = copyFixture("v8-main-2b05680");
      const db = new Database(path);
      // A direct write (ruling M18): no real step removes schema_meta from a checkpoint.
      db.exec("DROP TABLE schema_meta");
      db.close();
      return path;
    },
  },
  { reason: "older than v7 (schema v6)", make: () => copyFixture("v6-v0.7.0") },
];

for (const c of INCOMPATIBLE) {
  test(
    `a checkpoint ${c.shape ?? c.reason} is listed as such, never as damaged, and clean refuses it (exit 65)`,
    async () => {
      const root = makeTempDir("styre-readers-state-");
      const dir = join(root, "fixture", "ENG-1");
      mkdirSync(dir, { recursive: true });
      copyFileSync(c.make(), join(dir, "run.db"));
      const found = listCheckpoints(root);
      expect(found.map((x) => [x.ident, x.kind, x.note])).toEqual([
        ["ENG-1", "incompatible", c.reason],
      ]);
      const out = await captureStdout(() => lsImpl({ root, swept: [] }));
      expect(out).toContain("Checkpoints this Styre cannot use (");
      expect(out).toContain(`fixture/ENG-1  ${c.reason}`);
      const before = treeOf(root);
      const refusal = await cleanImpl(
        { ident: "ENG-1", slug: "fixture" },
        { root, targetRepo: gitRepo() },
      ).catch((e: unknown) => e);
      expect((refusal as { code?: number }).code).toBe(65);
      expect(String((refusal as { headline?: string }).headline)).toContain(c.reason);
      // the way that keeps the paused work comes first
      expect(String((refusal as { recovery?: string }).recovery)).toStartWith(
        "Nothing was removed. To keep the paused work, use the Styre that wrote it;",
      );
      expect(treeOf(root)).toEqual(before);
    },
    TIMEOUT_MS,
  );
}

test(
  "clean --all skips unreadable and incompatible checkpoints",
  async () => {
    const { root } = unreadableEffort("ENG-9");
    const incompatible = join(root, "fixture", "ENG-1");
    mkdirSync(incompatible, { recursive: true });
    copyFileSync(copyFixture("v6-v0.7.0"), join(incompatible, "run.db"));
    const before = treeOf(root);
    const out = await captureStdout(() =>
      cleanImpl({ all: true, slug: "fixture" }, { root, targetRepo: gitRepo() }),
    );
    expect(out).toContain("reaped 0 finished leftover(s); kept 2");
    expect(treeOf(root)).toEqual(before);
  },
  TIMEOUT_MS,
);

test(
  "ls and clean --all reach the folders they reach today: a nested slug is not reached, symbolic links are followed",
  async () => {
    const root = makeTempDir("styre-readers-state-");
    /** A finished (`done`) checkpoint at `dir`, from a private copy of a fixture. */
    const done = (dir: string) => {
      mkdirSync(dir, { recursive: true });
      const dbPath = join(dir, "run.db");
      copyFileSync(copyFixture("v8-main-2b05680"), dbPath);
      const db = new Database(dbPath);
      try {
        // A direct write (ruling M18): this binary's steps cannot advance a fixture of an older
        // era to `done`, and only a finished effort is what `clean --all` reaps.
        db.exec("UPDATE ticket SET status = 'done'");
      } finally {
        db.close();
      }
    };
    // a finished checkpoint under a nested slug: today neither `ls` nor `clean --all` reaches it
    done(join(root, "team", "app", "ENG-2"));
    // a checkpoint folder and a slug folder behind symbolic links: today `ls` lists both
    const elsewhere = makeTempDir("styre-readers-linked-");
    done(join(elsewhere, "ENG-5"));
    done(join(elsewhere, "slug", "ENG-4"));
    mkdirSync(join(root, "web"), { recursive: true });
    symlinkSync(join(elsewhere, "ENG-5"), join(root, "web", "ENG-5"));
    symlinkSync(join(elsewhere, "slug"), join(root, "linked"));
    const listed = listCheckpoints(root)
      .map((c) => `${c.slug}|${c.ident}|${c.kind}`)
      .sort();
    expect(listed).toEqual(["linked|ENG-4|done", "web|ENG-5|done"]);
    const before = treeOf(root);
    for (const slug of ["team/app", "team"]) {
      const out = await captureStdout(() =>
        cleanImpl({ all: true, slug }, { root, targetRepo: gitRepo() }),
      );
      expect([slug, out]).toEqual([
        slug,
        "styre clean: reaped 0 finished leftover(s); kept 0 resumable/unknown; 0 failed\n",
      ]);
    }
    expect(treeOf(root)).toEqual(before); // nothing under `team` was reaped
  },
  TIMEOUT_MS,
);

/** Idents that are not one folder name, and slugs with a part that is not one folder name
 *  (operator rulings, 2026-10-10: a slug may nest with "/", an ident may not). */
const BAD_IDENTS = [".", "..", "../styre.db", "", "a/b", "a\\b", "a\0b"];
const BAD_SLUGS = [
  ".",
  "..",
  "../styre.db",
  "",
  "a\\b",
  "a\0b",
  "team/..",
  "/abs",
  "a//b",
  "a/./b",
  "team/",
];

test(
  "clean refuses an ident or slug that is not a valid folder name (64), before touching anything",
  async () => {
    // a state root with a paused run, a live run and the global database, as `styre clean` sees it
    const root = makeTempDir("styre-readers-state-");
    copyFileSync(copyFixture("v8-main-2b05680"), join(root, "styre.db"));
    for (const ident of ["ENG-1", "ENG-2"]) {
      mkdirSync(join(root, "fixture", ident), { recursive: true });
      copyFileSync(copyFixture("v8-main-2b05680"), join(root, "fixture", ident, "run.db"));
    }
    lockByLiveRun(join(root, "fixture", "ENG-2"));
    // damaged run.db files where a bad name would lead without the check: ident `..` with slug
    // `fixture` reaches the root; ident `ENG-1` with slug `team/..`, `/abs`, `a//b` or `a/./b`
    // reaches root/ENG-1, root/abs/ENG-1 and root/a/b/ENG-1. Each would give 65, not 64.
    writeFileSync(join(root, "run.db"), "not a database");
    for (const dir of [
      join(root, "ENG-1"),
      join(root, "abs", "ENG-1"),
      join(root, "a", "b", "ENG-1"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "run.db"), "not a database");
    }
    const before = treeOf(root);
    const repo = gitRepo();
    const cases = [
      ...BAD_IDENTS.map((name) => ({ ident: name, slug: "fixture" })),
      ...BAD_IDENTS.map((name) => ({ ident: name, slug: "fixture", purge: true })),
      ...BAD_SLUGS.map((name) => ({ ident: "ENG-1", slug: name })),
      // `--all` builds no checkpoint path, so only cleanImpl's own slug check refuses these
      ...BAD_SLUGS.map((name) => ({ all: true, slug: name })),
    ];
    for (const args of cases) {
      const refusal = await cleanImpl(args, { root, targetRepo: repo }).catch((e: unknown) => e);
      expect([JSON.stringify(args), (refusal as { code?: number } | undefined)?.code]).toEqual([
        JSON.stringify(args),
        64,
      ]);
    }
    expect(treeOf(root)).toEqual(before);
  },
  TIMEOUT_MS,
);

test(
  "--resume refuses an ident or slug that is not one folder name (64), though a run.db waits where it leads",
  async () => {
    const state = makeTempDir("styre-readers-names-");
    const styre = join(state, "styre"); // parkDir(slug, ident) is <state>/styre/<slug>/<ident>
    const cases: [slug: string, ident: string, reached: string][] = [
      ["inspect", ".", join(styre, "inspect")],
      ["inspect", "..", styre],
      ["inspect", "../styre.db", join(styre, "styre.db")],
      ["..", "ENG-1", join(state, "ENG-1")],
    ];
    // without the check each case finds a real paused run there, takes its lock and inspects it
    for (const [, , reached] of cases) {
      mkdirSync(reached, { recursive: true });
      copyFileSync(copyFixture("v8-main-2b05680"), join(reached, "run.db"));
    }
    const before = treeOf(state);
    const repo = gitRepo();
    await withEnv("XDG_STATE_HOME", state, async () => {
      for (const [slug, ident] of cases) {
        const profile = parseProfile({ slug, targetRepo: repo, components: [] });
        const refusal = await inspectResume({ resume: ident }, profile).catch((e: unknown) => e);
        const code = (refusal as { code?: number } | undefined)?.code;
        expect([slug, ident, code]).toEqual([slug, ident, 64]);
      }
    });
    expect(treeOf(state)).toEqual(before);
  },
  TIMEOUT_MS,
);

test(
  "styre run checks --slug, a derived slug and the ident (64) and the profile's own slug (78) before building a path",
  async () => {
    const config = makeTempDir("styre-readers-config-");
    const profileJson = (slug: string) =>
      JSON.stringify({ slug, targetRepo: gitRepo(), components: [] });
    // the profile `--slug ..` would reach without the check: <config>/styre/../profile.json
    writeFileSync(join(config, "profile.json"), profileJson("fixture"));
    const named = join(makeTempDir("styre-readers-profile-"), "profile.json");
    writeFileSync(named, profileJson(".."));
    // a valid profile: with --profile, only the --slug check sees the flag (run.ts builds
    // <config>/<slug>/config.json from it), since no slug is derived on that path
    const valid = join(makeTempDir("styre-readers-profile-"), "profile.json");
    writeFileSync(valid, profileJson("fixture"));
    // a repository without a remote whose folder name holds a backslash: run from inside it with no
    // --slug and no --profile, the slug is derived from the current folder (only the derived check
    // sees it, since args.slug is absent)
    const odd = repoAt(join(makeTempDir("styre-readers-cwd-"), "a\\b"));
    const codeOf = (args: { slug?: string; profile?: string }): number | undefined => {
      try {
        loadRunProfile(args);
      } catch (e) {
        return (e as { code?: number }).code;
      }
      return undefined;
    };
    await withEnv("XDG_CONFIG_HOME", config, () => {
      const cases: [args: { slug?: string; profile?: string }, code: number][] = [
        [{ slug: ".." }, 64],
        [{ slug: "a\\b" }, 64],
        [{ slug: "team/.." }, 64],
        [{ slug: "/abs" }, 64],
        [{ profile: valid, slug: ".." }, 64],
        [{ profile: valid, slug: "team/.." }, 64],
        [{ profile: named }, 78], // the slug comes from a profile file: EXIT.CONFIG
      ];
      for (const [args, expected] of cases) {
        expect([JSON.stringify(args), codeOf(args)]).toEqual([JSON.stringify(args), expected]);
      }
      const cwd = process.cwd();
      process.chdir(odd);
      let derived: number | undefined;
      try {
        derived = codeOf({});
      } finally {
        process.chdir(cwd);
      }
      expect(["derived from the current folder", derived]).toEqual([
        "derived from the current folder",
        64,
      ]);
    });
    // `clean --profile` reads the slug from the file too
    const profiled = await cleanImpl(
      { ident: "ENG-1", profile: named },
      { root: makeTempDir("styre-readers-state-"), targetRepo: gitRepo() },
    ).catch((e: unknown) => e);
    expect((profiled as { code?: number }).code).toBe(78);
    // the fresh run builds its checkpoint path from the tracker's ident through parkDir
    for (const ident of BAD_IDENTS) {
      expect(() => parkDir("fixture", ident)).toThrow("not a valid ident");
    }
    for (const slug of BAD_SLUGS) expect(() => parkDir(slug, "ENG-1")).toThrow("not a valid slug");
    expect(parkDir("fixture", "ENG-1").endsWith(join("fixture", "ENG-1"))).toBe(true);
    expect(parkDir("team/app", "ENG-1").endsWith(join("team", "app", "ENG-1"))).toBe(true);
  },
  TIMEOUT_MS,
);

/** What both setup tests start from: an empty config folder, a repository `app`, and one whose
 *  folder name holds a backslash (no remote, so its slug is derived from that name). */
function setupFixture(): { config: string; repo: string; odd: string } {
  return {
    config: makeTempDir("styre-readers-setup-config-"),
    repo: repoAt(join(makeTempDir("styre-readers-setup-"), "app")),
    odd: repoAt(join(makeTempDir("styre-readers-setup-"), "a\\b")),
  };
}

test(
  "styre setup refuses a slug that styre run would refuse (64), before the agent runs or anything is written",
  async () => {
    const { config, repo, odd } = setupFixture();
    const runner = new FakeAgentRunner(() => {
      throw new Error("the setup agent must not run");
    });
    const deps = { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: async () => {} };
    await withEnv("XDG_CONFIG_HOME", config, async () => {
      const cases: [dir: string, slug: string | undefined][] = [
        ...BAD_SLUGS.map((slug): [string, string] => [repo, slug]),
        [odd, undefined],
      ];
      for (const [dir, slug] of cases) {
        const refusal = await runSetup({ repo: dir, slug, deps }).catch((e: unknown) => e);
        const code = (refusal as { code?: number }).code;
        expect([dir, slug, code]).toEqual([dir, slug, 64]);
      }
    });
    expect(readdirSync(config)).toEqual([]); // no profile and no folder was written
  },
  TIMEOUT_MS,
);

test(
  "styre setup checks --slug and a derived slug itself, before the agent CLI check, and writes nothing (64)",
  async () => {
    const { config, repo, odd } = setupFixture();
    const preflight = () => {
      throw new Error("the agent CLI check must not run");
    };
    await withEnv("XDG_CONFIG_HOME", config, async () => {
      const cases: [dir: string, slug: string | undefined][] = [
        [repo, "team/.."],
        [repo, "/abs"],
        [repo, "a//b"],
        [odd, undefined],
      ];
      for (const [dir, slug] of cases) {
        const refusal = await setupImpl({ args: { repo: dir, slug } }, { preflight }).catch(
          (e: unknown) => e,
        );
        const code = (refusal as { code?: number }).code;
        expect([dir, slug, code]).toEqual([dir, slug, 64]);
      }
    });
    expect(readdirSync(config)).toEqual([]); // nothing was written under the config folder
  },
  TIMEOUT_MS,
);

test(
  "a nested slug (team/app) works for a fresh run, its pause, --resume and clean <ident>; ls does not list it, as today",
  async () => {
    const run = await runFreshTicket({ slug: "team/app" });
    try {
      const root = join(run.stateRoot, "styre");
      const ident = basename(run.checkpointDir);
      expect(run.checkpointDir).toBe(join(root, "team", "app", ident));
      expect(existsSync(run.dbPath)).toBe(true); // the pause left its checkpoint there
      // `ls` reads two levels, as today: a nested slug's checkpoint is not listed (ENG-491)
      expect(listCheckpoints(root)).toEqual([]);
      const profile = parseProfile({ slug: "team/app", targetRepo: run.repoDir, components: [] });
      await inspectResume({ resume: ident }, profile);
      expect(stderr.join("")).toContain("would re-dispatch step");
      await cleanImpl({ ident, slug: "team/app" }, { root, targetRepo: run.repoDir });
      expect(existsSync(run.checkpointDir)).toBe(false);
    } finally {
      run.cleanup();
    }
  },
  TIMEOUT_MS,
);

test(
  "--resume --inspect on a current checkpoint made by a fresh run changes nothing in its folder (ruling 2026-10-10)",
  async () => {
    // After Task 4 no committed fixture is current, so a real fresh run makes the current case.
    const run = await runFreshTicket();
    try {
      const ident = basename(run.checkpointDir);
      // every file with a digest of its bytes: run.db, -wal, -shm, transcript.json
      const folder = () =>
        treeOf(run.checkpointDir).map(([f, bytes]) => [
          f,
          new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        ]);
      const before = folder();
      const profile = parseProfile({
        slug: "test-project",
        targetRepo: run.repoDir,
        components: [],
      });
      await inspectResume({ resume: ident }, profile);
      // the same files with the same bytes: no migration, no open of the original (no WAL switch,
      // no -shm rewrite), no run row (markResumed would change resumed and attempt); run.lock was
      // made and removed again, as every resume does
      expect(folder()).toEqual(before);
      expect(stderr.join("")).toContain(`schema: v${CURRENT_VERSION}, current`);
    } finally {
      run.cleanup();
    }
  },
  TIMEOUT_MS,
);

test(
  "--resume --inspect reports a checkpoint it cannot read, one with no tables and one with no ticket, returns normally and changes nothing",
  async () => {
    // Each made as a broken input, not by a run: no real step leaves a checkpoint like these.
    const cases: { what: string; make: (path: string) => void; lines: string[] }[] = [
      {
        what: "not a database",
        make: (path) => writeFileSync(path, "not a database"),
        lines: ["  schema: cannot be read: file is not a database\n  (no changes made)\n"],
      },
      {
        what: "no tables",
        make: (path) => {
          const db = new Database(path);
          db.exec("PRAGMA user_version = 1"); // writes the file header, creates no table
          db.close();
        },
        lines: [
          "  schema: the checkpoint holds no tables\n",
          "  (the rest cannot be read on this shape: no such table: ticket)\n",
          "  (no changes made)\n",
        ],
      },
      {
        what: "tables but no ticket",
        make: (path) => {
          migrate(path);
        },
        lines: [
          `  schema: v${CURRENT_VERSION}, current\n`,
          "  (no ticket in this checkpoint)\n",
          "  (no changes made)\n",
        ],
      },
    ];
    const repo = gitRepo();
    for (const c of cases) {
      const state = makeTempDir("styre-readers-inspect-");
      const dir = join(state, "styre", "inspect", "ENG-1");
      mkdirSync(dir, { recursive: true });
      c.make(join(dir, "run.db"));
      const before = treeOf(dir);
      const from = stderr.length;
      const profile = parseProfile({ slug: "inspect", targetRepo: repo, components: [] });
      const done = await withEnv("XDG_STATE_HOME", state, () =>
        inspectResume({ resume: "ENG-1" }, profile).then(
          () => "returned",
          (e: unknown) => `threw: ${String(e)}`,
        ),
      );
      const out = stderr.slice(from).join("");
      expect([c.what, done]).toEqual([c.what, "returned"]);
      expect([c.what, out.startsWith("resume --inspect ENG-1\n")]).toEqual([c.what, true]);
      for (const line of c.lines)
        expect([c.what, out]).toEqual([c.what, expect.stringContaining(line)]);
      expect([c.what, treeOf(dir)]).toEqual([c.what, before]);
    }
  },
  TIMEOUT_MS,
);
