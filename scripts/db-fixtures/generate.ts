// scripts/db-fixtures/generate.ts
// Usage (from the repository root, with full history and tags): bun scripts/db-fixtures/generate.ts
// Rewrites test/fixtures/db/. Each fixture is produced by its own release's code, checked out in a
// temporary git worktree (spec §7.5). The v8 runs are driven by 2b05680, with this checkout's
// node_modules linked in (bun.lock is the same at 2b05680 and at this branch's base, 625e154;
// package.json differs only in its version). It must exist: the script refuses to start without it. Nothing is written under the real ~/.local/state, and nothing is left in the
// system temp folder: every child gets XDG folders and a TMPDIR inside one work folder, removed at
// the end. Each child has a time limit here and bounds itself too. If this script is killed, run
// `git worktree prune` and remove the work folder it printed.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = join(ROOT, "test/fixtures/db");
// The v8 driver runs 2b05680's own code, which imports npm packages (zod). Without this
// checkout's node_modules the link below would dangle, and Bun would resolve those imports from
// wherever it finds them, or not at all. Fail loudly before anything is made.
const MODULES = join(ROOT, "node_modules");
if (!existsSync(MODULES)) {
  throw new Error(
    `db-fixtures: ${MODULES} is missing; run \`bun install --frozen-lockfile\` in ${ROOT} first`,
  );
}
const ERAS = [
  { name: "v6-v0.7.0", ref: "v0.7.0", bridge: false },
  { name: "v7-v0.9.0", ref: "v0.9.0", bridge: false },
  { name: "v7-v0.9.0-bridged", ref: "v0.9.0", bridge: true },
  { name: "v7-v0.10.0", ref: "v0.10.0", bridge: false },
  { name: "v7-v0.10.0-bridged", ref: "v0.10.0", bridge: true },
  { name: "v8-v0.13.2", ref: "v0.13.2", bridge: false },
  { name: "v8-main-2b05680", ref: "2b05680", bridge: false },
] as const;
const RECORDINGS = [
  { dir: "v8-paused-worktree", scenario: "implement-budget" },
  { dir: "v8-plan-gate-worktree", scenario: "plan-gate" },
  { dir: "v8-redesign-graded-worktree", scenario: "redesign-budget-graded" },
] as const;

function run(argv: string[], cwd: string, env: Record<string, string>, timeoutMs: number): void {
  const r = Bun.spawnSync(argv, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...env },
    timeout: timeoutMs,
  });
  if (r.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} exited ${r.exitCode} ${r.signalCode ?? ""}`.trim());
  }
}

/** Commit fixtures in rollback journal (DELETE) mode, never WAL (operator ruling, 2026-10-09):
 *  fold the WAL in, switch the mode (written into the file header), then remove any -wal and -shm,
 *  which must never be committed. A WAL file copied without its side files cannot even be opened
 *  read only on macOS. */
function toDeleteMode(path: string): void {
  const db = new Database(path);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.exec("PRAGMA journal_mode = DELETE;");
  } finally {
    db.close();
  }
  for (const ext of ["-wal", "-shm"]) rmSync(`${path}${ext}`, { force: true });
}

const work = mkdtempSync(join(tmpdir(), "styre-db-fixtures-"));
process.stderr.write(`db-fixtures: working in ${work}\n`);
const childTmp = join(work, "tmp");
mkdirSync(childTmp);
const envFor = (name: string) => ({
  XDG_STATE_HOME: join(work, `state-${name}`),
  XDG_CONFIG_HOME: join(work, `config-${name}`),
  TMPDIR: childTmp,
  STYRE_TELEMETRY: "0",
});
const GIT_MS = 30_000;
// The generator's own git calls get the same isolated environment as the era children.
const gitEnv = envFor("git");
try {
  mkdirSync(OUT, { recursive: true });
  for (const e of ERAS) {
    const era = join(work, e.name);
    run(["git", "worktree", "add", "--detach", era, e.ref], ROOT, gitEnv, GIT_MS);
    try {
      const out = join(OUT, `${e.name}.db`);
      rmSync(out, { force: true });
      const seeder = join(ROOT, "scripts/db-fixtures/seed-era.ts");
      const mode = e.bridge ? "bridge" : "plain";
      run([process.execPath, seeder, era, out, mode], era, envFor(e.name), 60_000);
      toDeleteMode(out);
    } finally {
      run(["git", "worktree", "remove", "--force", era], ROOT, gitEnv, GIT_MS);
    }
  }
  const era = join(work, "v8-driver");
  run(["git", "worktree", "add", "--detach", era, "2b05680"], ROOT, gitEnv, GIT_MS);
  try {
    symlinkSync(MODULES, join(era, "node_modules"));
    for (const r of RECORDINGS) {
      const outDir = join(OUT, r.dir);
      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const driver = join(ROOT, "scripts/db-fixtures/drive-v8-run.ts");
      run([process.execPath, driver, era, outDir, r.scenario], era, envFor(r.dir), 300_000);
      toDeleteMode(join(outDir, "run.db"));
    }
  } finally {
    run(["git", "worktree", "remove", "--force", era], ROOT, gitEnv, GIT_MS);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
