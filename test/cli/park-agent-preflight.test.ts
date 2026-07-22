import { afterEach, expect, test } from "bun:test";

afterEach(() => {
  process.exitCode = 0;
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parkDir, resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { openDb } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrate.ts";
import { insertProject } from "../../src/db/repos/project.ts";
import { insertTicket, setTicketStage } from "../../src/db/repos/ticket.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";

/** Real temp git repo with one commit (resumeRun's branchHeadSha needs a repo to run against). */
function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-agentpf-resume-repo-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("resumeRun: a missing agent CLI throws (exit 69 error) before re-dispatch", async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "styre-agentpf-resume-state-"));
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  const repoPath = gitRepo();
  const slug = "agentpf-resume";
  const ident = "ENG-9";

  try {
    // Build the parked-run dump resumeRun reads: <XDG_STATE_HOME>/styre/<slug>/<ident>/run.db.
    const dir = parkDir(slug, ident);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "run.db");
    migrate(dbPath);
    const seedDb = openDb(dbPath);
    const projectId = insertProject(seedDb, { slug, targetRepo: repoPath });
    const ticketId = insertTicket(seedDb, { projectId, ident });
    setTicketStage(seedDb, ticketId, "implement");
    await runStep(seedDb, {
      ticketId,
      stepKey: "provision",
      stepType: "provision",
      effectful: true,
      execute: () => ({ ok: true }),
    });
    seedDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    seedDb.close();

    const profile = parseProfile({
      slug,
      targetRepo: repoPath,
      defaultBranch: "main",
      checksSystem: "none",
    });

    // Runtime config whose agent.command is a guaranteed-absent binary.
    const runtimeConfig = {
      ...DEFAULT_RUNTIME_CONFIG,
      agent: { ...DEFAULT_AGENT_CONFIG, command: "styre-absent-agent-cli-xyz" },
    };

    // buildRegistry sets a flag so we can prove the probe fired BEFORE dispatch.
    let dispatched = false;
    await expect(
      resumeRun({ resume: ident }, profile, runtimeConfig, {
        ports: {
          issueTracker: fakeIssueTracker({
            ticket: {
              ident,
              title: "t",
              description: "b",
              typeLabel: "Feature",
              externalId: "uuid",
              url: null,
            },
          }),
          forge: fakeForge(),
          checks: fakeChecks("passing"),
        },
        buildRegistry: () => {
          dispatched = true;
          throw new Error("should not reach dispatch");
        },
      }),
    ).rejects.toThrow(/not installed or not on PATH/);
    expect(dispatched).toBe(false);
  } finally {
    // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
    if (prev === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev;
  }
});
