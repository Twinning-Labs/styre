import type { Database } from "bun:sqlite";
import { realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG, type RuntimeConfig } from "../../src/config/runtime-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { captureSnapshot } from "../../src/daemon/design-inputs.ts";
import { type StepDescriptor, nextStepKey } from "../../src/daemon/resolver.ts";
import type { StepRegistry } from "../../src/daemon/step-registry.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertRun } from "../../src/db/repos/run.ts";
import { getTicket, insertTicket } from "../../src/db/repos/ticket.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { type Profile, parseProfile } from "../../src/dispatch/profile.ts";
import { pendingLeftoverChecks } from "../../src/util/process/leftovers.ts";
import { nowUtc } from "../../src/util/time.ts";
import {
  type DesignScript,
  type ScriptCalls,
  type ScriptUnit,
  defaultScript,
  harnessProfileRaw,
  newCalls,
  scriptedRunner,
  unitsOf,
} from "./design-script.ts";
import { makeTempDir, onTempCleanup } from "./temp.ts";

/** Every test that drives design steps passes this as its bun test timeout: the steps run git. */
export const STEP_TEST_TIMEOUT_MS = 30_000;

/** git with a time limit: the child is stopped by its own handle if it hangs. */
export function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A repository with one commit, in a temp folder removed when the test ends. */
export function gitRepo(prefix = "styre-ds-repo-"): string {
  const root = realpathSync(makeTempDir(prefix));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@s.dev"]);
  git(root, ["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

/** A ticket in a migrated database, with its snapshot captured and the real dispatch registry over
 *  a scripted fake agent. Steps run only through advanceOneStep. */
export interface DesignTicket {
  db: Database;
  ticketId: number;
  repo: string;
  worktreeRoot: string;
  profile: Profile;
  config: RuntimeConfig;
  script: DesignScript;
  calls: ScriptCalls;
  registry: StepRegistry;
}

export function makeDesignTicket(
  opts: {
    script?: Partial<DesignScript>;
    profile?: (repo: string) => Record<string, unknown>;
    config?: Partial<RuntimeConfig>;
    /** Runs on the new repository before anything else (a .gitignore, say). */
    repoSetup?: (repo: string) => void;
  } = {},
): DesignTicket {
  const repo = gitRepo();
  opts.repoSetup?.(repo);
  const dbPath = join(makeTempDir("styre-ds-db-"), "run.db");
  migrate(dbPath);
  const db = openDb(dbPath);
  onTempCleanup(() => db.close()); // closed when the test ends, before its folder is removed
  const profile = parseProfile((opts.profile ?? harnessProfileRaw)(repo));
  const projectId = insertProject(db, {
    slug: profile.slug,
    targetRepo: repo,
    defaultBranch: "main",
  });
  const ticketId = insertTicket(db, {
    projectId,
    ident: "ENG-1",
    title: "Design ticket",
    description: "Design body",
    typeLabel: "Feature",
    branchPrefix: "feat",
  });
  insertRun(db, { runId: "design-steps-run", startedAt: nowUtc(), provider: "claude" });
  const config: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG, ...opts.config };
  captureSnapshot(db, ticketId, {
    profile,
    unusableComponents: [],
    nonPrimaryComponents: [],
    config,
  });
  const calls = newCalls();
  const script = defaultScript({ ident: "ENG-1", ...opts.script });
  const worktreeRoot = makeTempDir("styre-ds-wt-");
  const registry = buildDispatchRegistry({
    runner: scriptedRunner(script, calls),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile,
    worktreeRoot,
  });
  return { db, ticketId, repo, worktreeRoot, profile, config, script, calls, registry };
}

/** Advance until `stop` holds for the next descriptor (checked before each step). After each step
 *  it waits for the background leftover check the step started (ENG-485 section 9.1), as
 *  `driveToTerminal` does: a check still running when the test ends keeps the command temp folder. */
export async function driveUntil(
  t: Pick<DesignTicket, "db" | "ticketId" | "registry" | "config">,
  stop: (d: StepDescriptor) => boolean,
  maxSteps = 40,
): Promise<StepDescriptor> {
  for (let i = 0; i < maxSteps; i++) {
    const d = nextStepKey(t.db, t.ticketId);
    if (stop(d)) return d;
    await advanceOneStep(t.db, t.ticketId, t.registry, { config: t.config });
    await pendingLeftoverChecks();
  }
  throw new Error(`driveUntil: no stop after ${maxSteps} steps`);
}

export const atStep =
  (stepKey: string) =>
  (d: StepDescriptor): boolean =>
    d.kind === "step" && d.stepKey === stepKey;

/** For the existing tests that used to seed rows (spec §8): run the real design steps, with a
 *  scripted agent, until `target` is the next step. `target` is a design table step or
 *  `checks:dispatch`, the first step after the table. Uses the caller's profile, worktree root and
 *  mode (`inPlace`), so the caller's own registry then finds the same worktree or checkout. `units`
 *  is what the scripted `design:extract` returns. */
export async function reachDesignStep(opts: {
  db: Database;
  ticketId: number;
  profile: Profile;
  worktreeRoot: string;
  target: string;
  units?: ScriptUnit[];
  config?: RuntimeConfig;
  inPlace?: boolean;
}): Promise<ScriptCalls> {
  const ident = getTicket(opts.db, opts.ticketId)?.ident ?? "ENG-1";
  const calls = newCalls();
  const units = opts.units ?? unitsOf(2, { behavioral: false, dir: "src", ext: "ts" });
  const script = defaultScript({ ident, units: () => units });
  const registry = buildDispatchRegistry({
    runner: scriptedRunner(script, calls),
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: opts.profile,
    worktreeRoot: opts.worktreeRoot,
    inPlace: opts.inPlace ?? false,
  });
  await driveUntil(
    {
      db: opts.db,
      ticketId: opts.ticketId,
      registry,
      config: opts.config ?? DEFAULT_RUNTIME_CONFIG,
    },
    atStep(opts.target),
    20,
  );
  return calls;
}

/** For the checks tests that used to mark design done by hand (spec §8): run the real design
 *  steps until `checks:dispatch` is next, with the one planned unit those tests seeded. Provision
 *  runs here (creating the worktree), so the caller's first step is `checks:dispatch`. A behavioural
 *  unit carries its own test file (validateExtraction requires it): `testFile`, or a `tests/` file
 *  beside the unit's first file, which the default test file pattern matches. */
export async function reachChecksStep(opts: {
  db: Database;
  ticketId: number;
  profile: Profile;
  worktreeRoot: string;
  inPlace?: boolean;
  unit: {
    kind: string;
    behavioral: boolean;
    verifyCheckTypes: string[];
    filesToTouch?: string[];
    testFile?: string;
  };
}): Promise<void> {
  const files = opts.unit.filesToTouch ?? ["src/unit1.py"];
  const first = files[0] ?? "src/unit1.py";
  const testFile = opts.unit.testFile ?? `${dirname(first)}/tests/test_${basename(first)}`;
  await reachDesignStep({
    db: opts.db,
    ticketId: opts.ticketId,
    profile: opts.profile,
    worktreeRoot: opts.worktreeRoot,
    inPlace: opts.inPlace,
    target: "checks:dispatch",
    units: [
      {
        seq: 1,
        kind: opts.unit.kind,
        title: "Unit 1",
        description: "Change 1",
        behavioral: opts.unit.behavioral,
        test_plan: opts.unit.behavioral ? `${testFile} asserts change 1` : null,
        files_to_touch: opts.unit.behavioral ? [...files, testFile] : files,
        verify_check_types: opts.unit.verifyCheckTypes,
        depends_on: [],
      },
    ],
  });
}
