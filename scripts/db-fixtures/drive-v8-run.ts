// scripts/db-fixtures/drive-v8-run.ts
// Usage: XDG_STATE_HOME=<tmp> XDG_CONFIG_HOME=<tmp> TMPDIR=<tmp> \
//   bun scripts/db-fixtures/drive-v8-run.ts <eraRoot> <outDir> <scenario>
// Drives a real worktree mode `styre run` with the 2b05680 code (the last v8 writer) and a scripted
// fake agent to one stop, and records it (spec §7.5: a recorded database of a real paused run).
// Two units that are not behavioural, so the track is full and design:review runs; no runnable
// check framework, so checks:dispatch authors nothing.
//   implement-budget        every design step succeeds; the implement dispatch hits a session limit
//   plan-gate               every plan review returns the same blocking finding: one redesign, then
//                           the escalation at the plan review gate (needs_you)
//   redesign-budget-graded  complexityGrading on; the first plan review blocks, and the redesign's
//                           regenerated design:dispatch hits a session limit
// Writes to <outDir>: run.db, transcript.json (budget pauses only), repo.bundle, meta.json.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCENARIOS = ["implement-budget", "plan-gate", "redesign-budget-graded"] as const;
type Scenario = (typeof SCENARIOS)[number];
const [eraRoot, outDir, scenarioArg] = process.argv.slice(2);
if (!eraRoot || !outDir || !SCENARIOS.includes(scenarioArg as Scenario)) {
  throw new Error(`usage: drive-v8-run.ts <eraRoot> <outDir> <${SCENARIOS.join("|")}>`);
}
const scenario = scenarioArg as Scenario;
if (!process.env.XDG_STATE_HOME) throw new Error("set XDG_STATE_HOME to a temporary folder");
// Bounded on its own, so nothing outlives a generator that was stopped (its limit is 300 s).
setTimeout(() => {
  process.stderr.write("drive-v8-run: time limit reached\n");
  process.exit(3);
}, 280_000).unref();
const era = (p: string) => import(join(eraRoot, p));

const { FakeAgentRunner } = await era("src/agent/fake-runner.ts");
const { DEFAULT_AGENT_CONFIG } = await era("src/config/agent-config.ts");
const { DEFAULT_RUNTIME_CONFIG } = await era("src/config/runtime-config.ts");
const { runTicket } = await era("src/daemon/run-ticket.ts");
const { openDb } = await era("src/db/client.ts");
const { migrate } = await era("src/db/migrate.ts");
const { insertRun } = await era("src/db/repos/run.ts");
const { buildDispatchRegistry } = await era("src/dispatch/handlers.ts");
const { parseProfile } = await era("src/dispatch/profile.ts");
const { finishRunResult, parkDir } = await era("src/cli/park.ts");
const { fakeIssueTracker } = await era("src/integrations/adapters/fake-issue-tracker.ts");
const { fakeForge } = await era("src/integrations/adapters/fake-forge.ts");

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// tmpdir() is the generator's work folder (TMPDIR), which it removes.
const repo = mkdtempSync(join(tmpdir(), "styre-v8-recording-repo-"));
git(["init", "-b", "main"], repo);
git(["config", "user.email", "t@s.dev"], repo);
git(["config", "user.name", "T"], repo);
writeFileSync(join(repo, "README.md"), "fixture\n");
git(["add", "-A"], repo);
git(["commit", "-m", "init"], repo);

const ABSENT_RC = {
  topology: { type: "cli" },
  data: { presence: "absent" },
  caching: { presence: "absent" },
  observability: { presence: "absent" },
  configSecrets: { presence: "absent" },
  documentation: { presence: "absent" },
  releasePackaging: { mechanism: "none" },
};
const profile = parseProfile({
  slug: "fixture",
  targetRepo: repo,
  defaultBranch: "main",
  checksSystem: "none",
  components: [
    {
      name: "app",
      kind: "ruby",
      paths: ["**"],
      commands: { build: "true", test: "true", check: "true" },
    },
  ],
  promptVars: { stack: "ruby" },
  runtimeContext: ABSENT_RC,
});
const sidecar = (v: unknown) => `Done.\n\n\`\`\`styre-sidecar\n${JSON.stringify(v)}\n\`\`\`\n`;
const ok = (stdout: string) => ({
  completed: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});
const sessionLimit = () => ({
  completed: false,
  exitCode: 1,
  stdout: "partial output written before the session limit",
  stderr: "You have reached your session limit · resets tomorrow",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
  cause: "session-limit",
  resetAt: "tomorrow",
});
// The same fields as test/helpers/design-script.ts unitsOf(2, { behavioral: false }), so a resumed
// run that extracts again gets the same units digest.
const units = [1, 2].map((seq) => ({
  seq,
  kind: "backend",
  title: `Unit ${seq}`,
  description: `Change ${seq}`,
  behavioral: false,
  test_plan: null,
  files_to_touch: [`lib/u${seq}.rb`],
  verify_check_types: [],
  depends_on: [],
}));
const blocking = {
  severity: "critical",
  category: "feasibility",
  location: "plan:Unit 1",
  rationale: "RECORDED-BLOCKING-FINDING",
  factors: null,
  deferral_candidate: false,
  work_unit_seq: null,
};
const calls = { dispatch: 0, review: 0 };
const runner = new FakeAgentRunner((input: { prompt: string; cwd: string }) => {
  if (input.prompt.includes("You are designing ticket")) {
    calls.dispatch += 1;
    if (scenario === "redesign-budget-graded" && calls.dispatch === 2) return sessionLimit();
    mkdirSync(join(input.cwd, "docs", "plans"), { recursive: true });
    writeFileSync(
      join(input.cwd, "docs", "plans", "eng-1-plan.md"),
      `---\nlinear: ENG-1\n---\n\nRecorded plan, version ${calls.dispatch}\n`,
    );
    return ok("Plan written.");
  }
  if (input.prompt.includes("You are extracting the work breakdown")) {
    return ok(sidecar({ units, cdotImpact: {} }));
  }
  if (input.prompt.includes("You are grading the COMPLEXITY")) {
    return ok(sidecar({ dimensions: { coupling: 0, blast_radius: 0, difficulty: 0 }, overall: 6 }));
  }
  if (input.prompt.includes("You are the independent plan reviewer")) {
    calls.review += 1;
    const block =
      scenario === "plan-gate" || (scenario === "redesign-budget-graded" && calls.review === 1);
    return ok(sidecar({ findings: block ? [blocking] : [] }));
  }
  if (input.prompt.includes("You are implementing work-unit")) return sessionLimit();
  throw new Error(`drive-v8-run: unexpected prompt: ${input.prompt.slice(0, 80)}`);
});

const dbPath = join(parkDir("fixture", "ENG-1"), "run.db");
mkdirSync(parkDir("fixture", "ENG-1"), { recursive: true });
migrate(dbPath);
const db = openDb(dbPath);
insertRun(db, {
  runId: `v8-recording-${scenario}`,
  startedAt: new Date().toISOString(),
  provider: "claude",
});
const worktreeRoot = mkdtempSync(join(tmpdir(), "styre-v8-recording-wt-"));
const registry = buildDispatchRegistry({
  runner,
  agentConfig: DEFAULT_AGENT_CONFIG,
  profile,
  worktreeRoot,
  inPlace: false,
});
const ingested = {
  ident: "ENG-1",
  title: "Recorded ticket",
  description: "Recorded body",
  typeLabel: "Feature",
  externalId: "uuid-v8-recording",
  url: null,
};
const runtimeConfig =
  scenario === "redesign-budget-graded"
    ? { ...DEFAULT_RUNTIME_CONFIG, complexityGrading: true }
    : DEFAULT_RUNTIME_CONFIG;
const out = await runTicket({
  db,
  profile,
  runtimeConfig,
  ports: { issueTracker: fakeIssueTracker({ ticket: ingested }), forge: fakeForge() },
  registry,
  ticketRef: "ENG-1",
  ingested,
});
const reason = scenario === "plan-gate" ? "needs_you" : "budget";
if (out.outcome !== "paused" || out.reason !== reason) {
  throw new Error(`drive-v8-run: expected a ${reason} pause, got ${out.outcome}/${out.reason}`);
}
// A budget pause goes through dumpPark (it checkpoints the WAL and writes transcript.json). A
// needs_you pause only closes the database, so fold the WAL in first.
if (reason === "needs_you") db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
finishRunResult(db, dbPath, "fixture", "ENG-1", out);
copyFileSync(dbPath, join(outDir, "run.db"));
const transcript = join(parkDir("fixture", "ENG-1"), "transcript.json");
if (existsSync(transcript)) copyFileSync(transcript, join(outDir, "transcript.json"));
git(["worktree", "prune"], repo);
git(["bundle", "create", join(outDir, "repo.bundle"), "--all"], repo);
const meta = {
  slug: "fixture",
  ident: "ENG-1",
  branch: "feat/ENG-1",
  scenario,
  targetRepoAtRecording: repo,
  worktreeRootAtRecording: worktreeRoot,
};
writeFileSync(join(outDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
// finishRunResult set the exit code of a paused `styre run` (75). This script succeeded.
process.exitCode = 0;
