import type { Database } from "bun:sqlite";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { StyreError } from "../../src/cli/errors.ts";
import { renderError } from "../../src/cli/output.ts";
import { parkDir } from "../../src/cli/park.ts";
import { type RunArgs, runImpl } from "../../src/cli/run.ts";
import { readCopyOf } from "../../src/db/read-copy.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import {
  type DesignScript,
  type ScriptCalls,
  defaultScript,
  harnessProfileRaw,
  newCalls,
  scriptedRunner,
} from "./design-script.ts";
import { gitRepo } from "./design-steps.ts";
import { makeTempDir, trackTempEntriesMadeBy } from "./temp.ts";

export type HostProbe = (repoDir: string, command: string) => boolean;

/** Every test that drives the harness passes this as its bun test timeout: each run starts git
 *  children (each bounded by its own 30 s limit) and drives the whole run in process. */
export const HARNESS_TEST_TIMEOUT_MS = 60_000;

export interface HarnessRunOptions {
  script?: Partial<DesignScript>;
  /** `styre run --db <path>` (a reused database). */
  db?: string;
  acceptHead?: boolean;
  /** `styre run --resume <ticket> --inspect`. */
  inspect?: boolean;
  /** What the tracker would say now; resume must never ask it (E2). */
  trackerTitle?: string;
}

/** The whole `styre run` and `styre run --resume`, through runImpl, with a scripted agent, fake
 *  tracker and forge, a profile and a config file the test can edit between runs, and the host's
 *  tools decided by `probe`. Every call sets XDG_STATE_HOME and XDG_CONFIG_HOME to this harness's
 *  own folders and restores them after. Its folders are made with makeTempDir, and the
 *  `styre-wt-*` worktree root each run keeps is tracked, so nothing outlives the test. Resume more
 *  than once only in "in-place" mode, unless the run committed on the recreated branch in between:
 *  in worktree mode each resume recreates the ticket branch from the target repository's checked
 *  out HEAD (`git worktree add -B`, ENG-488), which moves HEAD, so the next resume is refused
 *  (exit 65) while no dispatch has recorded the new HEAD (hand off note 10). */
export class DesignHarness {
  readonly stateRoot = makeTempDir("styre-dh-state-");
  readonly configRoot = makeTempDir("styre-dh-config-");
  readonly filesRoot = makeTempDir("styre-dh-files-");
  readonly repoDir: string;
  readonly profilePath = join(this.filesRoot, "profile.json");
  readonly configPath = join(this.filesRoot, "config.json");
  readonly calls: ScriptCalls = newCalls();
  readonly ident = "ENG-1";
  readonly slug: string;
  probe: HostProbe = () => true;
  /** What the last invocation wrote to stderr: `process.stderr.write`, `console.error` and
   *  `console.warn`, and, when it ends in a StyreError, the error boundary's rendering of it
   *  (`styre run: <headline>`). Reset at the start of each invocation, like `trackerCalls`. */
  stderr: string[] = [];
  /** What the last invocation wrote to stdout (the NDJSON telemetry, `console.log`/`console.info`):
   *  captured, never printed. Reset at the start of each invocation. */
  stdout: string[] = [];
  /** The fake tracker's calls during the last invocation (E2: a resume makes no `fetchTicket`). */
  trackerCalls: Array<{ method: string; args: unknown[] }> = [];
  private profileRaw: Record<string, unknown>;
  private configRaw: Record<string, unknown> = { complexityGrading: false };

  /** `opts.repoDir` adopts an existing repository (a restored recording); `opts.slug` names the
   *  project, which keys the checkpoint folder. */
  constructor(
    readonly mode: "worktree" | "in-place" = "worktree",
    opts: { slug?: string; repoDir?: string } = {},
  ) {
    this.slug = opts.slug ?? "harness";
    this.repoDir = opts.repoDir ?? gitRepo("styre-dh-repo-");
    this.profileRaw = harnessProfileRaw(this.repoDir, this.slug);
    if (mode === "in-place") {
      writeFileSync(join(this.repoDir, ".styre-disposable"), "");
      writeFileSync(join(this.repoDir, ".git", "info", "exclude"), ".styre-disposable\n");
    }
    this.write();
  }

  private write(): void {
    writeFileSync(this.profilePath, JSON.stringify(this.profileRaw, null, 2));
    writeFileSync(this.configPath, JSON.stringify(this.configRaw, null, 2));
  }

  editProfile(fn: (raw: Record<string, unknown>) => void): void {
    fn(this.profileRaw);
    this.write();
  }

  editConfig(fn: (raw: Record<string, unknown>) => void): void {
    fn(this.configRaw);
    this.write();
  }

  private withEnv<T>(fn: () => T): T {
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = this.stateRoot;
    try {
      return fn();
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
      else process.env.XDG_STATE_HOME = prev;
    }
  }

  checkpointDir(): string {
    return this.withEnv(() => parkDir(this.slug, this.ident));
  }

  dbPath(): string {
    return join(this.checkpointDir(), "run.db");
  }

  read<T>(fn: (db: Database, ticketId: number) => T): T {
    return this.readAt(this.dbPath(), fn);
  }

  readAt<T>(path: string, fn: (db: Database, ticketId: number) => T): T {
    return readCopyOf(path, (db) => {
      // by ident: a reused --db can hold other tickets, with lower ids
      const rows = db
        .query<{ id: number }, [string]>("SELECT id FROM ticket WHERE ident = ?")
        .all(this.ident);
      if (rows.length !== 1)
        throw new Error(`harness: ${rows.length} tickets named ${this.ident} in ${path}`);
      return fn(db, rows[0].id);
    });
  }

  async fresh(opts: HarnessRunOptions = {}): Promise<number> {
    return this.invoke(
      {
        ticket: this.ident,
        ...(opts.db ? { db: opts.db } : {}),
        ...(this.mode === "in-place" ? { "in-place": true } : {}),
      },
      opts,
    );
  }

  async resume(opts: HarnessRunOptions = {}): Promise<number> {
    return this.invoke(
      {
        resume: this.ident,
        ...(opts.acceptHead ? { "accept-head": true } : {}),
        ...(opts.inspect ? { inspect: true } : {}),
      },
      opts,
    );
  }

  private async invoke(args: Partial<RunArgs>, opts: HarnessRunOptions): Promise<number> {
    const script = defaultScript({ ident: this.ident, ...opts.script });
    const runner = scriptedRunner(script, this.calls);
    const issueTracker = fakeIssueTracker({
      ticket: {
        ident: this.ident,
        title: opts.trackerTitle ?? "Harness ticket",
        description: "Harness body",
        typeLabel: "Feature",
        externalId: "uuid-harness",
        url: null,
      },
    });
    this.trackerCalls = issueTracker.calls;
    this.stderr = [];
    this.stdout = [];
    const ports = { issueTracker, forge: fakeForge() };
    const prev = {
      state: process.env.XDG_STATE_HOME,
      config: process.env.XDG_CONFIG_HOME,
      telemetry: process.env.STYRE_TELEMETRY,
      exit: process.exitCode ?? 0,
      cwd: process.cwd(),
      errWrite: process.stderr.write,
      outWrite: process.stdout.write,
      error: console.error,
      warn: console.warn,
      log: console.log,
      info: console.info,
    };
    process.env.XDG_STATE_HOME = this.stateRoot;
    process.env.XDG_CONFIG_HOME = this.configRoot;
    process.env.STYRE_TELEMETRY = "0";
    const text = (chunk: unknown): string =>
      typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    // On Bun, console.error does not go through process.stderr.write: each is captured itself.
    process.stderr.write = ((chunk: unknown) => {
      this.stderr.push(text(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      this.stdout.push(text(chunk));
      return true;
    }) as typeof process.stdout.write;
    console.error = (...a: unknown[]) => void this.stderr.push(`${format(...a)}\n`);
    console.warn = console.error;
    console.log = (...a: unknown[]) => void this.stdout.push(`${format(...a)}\n`);
    console.info = console.log;
    if (args["in-place"]) process.chdir(this.repoDir); // in-place discovers the repo from the cwd
    try {
      process.exitCode = 0;
      // runImpl and resume keep the run's styre-wt-* worktree root (also in place): tracked here.
      await trackTempEntriesMadeBy("styre-wt-", () =>
        runImpl(
          { args: { profile: this.profilePath, config: this.configPath, ...args } },
          { ports, runner, preflight: () => ({ ok: true, version: null }), probe: this.probe },
        ),
      );
      return Number(process.exitCode ?? 0);
    } catch (err) {
      if (err instanceof StyreError) {
        this.stderr.push(`${renderError("run", err)}\n`); // what the error boundary prints
        return err.code;
      }
      throw err;
    } finally {
      process.stderr.write = prev.errWrite;
      process.stdout.write = prev.outWrite;
      console.error = prev.error;
      console.warn = prev.warn;
      console.log = prev.log;
      console.info = prev.info;
      process.chdir(prev.cwd);
      process.exitCode = prev.exit;
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      };
      restore("XDG_STATE_HOME", prev.state);
      restore("XDG_CONFIG_HOME", prev.config);
      restore("STYRE_TELEMETRY", prev.telemetry);
    }
  }

  /** Optional: the folders are removed when the test ends anyway (makeTempDir). */
  cleanup(): void {
    for (const d of [this.stateRoot, this.configRoot, this.filesRoot, this.repoDir])
      rmSync(d, { recursive: true, force: true });
  }
}
