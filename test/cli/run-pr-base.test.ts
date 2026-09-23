import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { cleanupParkedRun, runFreshTicket, runParkedTicket } from "../helpers/run-harness.ts";

function recordedDefaultBranch(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT default_branch FROM project").get() as { default_branch: string })
      .default_branch;
  } finally {
    db.close();
  }
}

test("a fresh run targets the forge's default branch when the profile names a missing one", async () => {
  const run = await runFreshTicket({
    defaultBranch: "master",
    forge: fakeForge({ defaultBranch: "main", branches: ["main"] }),
  });
  try {
    expect(recordedDefaultBranch(run.dbPath)).toBe("main");
  } finally {
    run.cleanup();
  }
});

test("a fresh run keeps a profile branch that exists on the forge", async () => {
  const run = await runFreshTicket({
    defaultBranch: "develop",
    forge: fakeForge({ defaultBranch: "main", branches: ["main", "develop"] }),
  });
  try {
    expect(recordedDefaultBranch(run.dbPath)).toBe("develop");
  } finally {
    run.cleanup();
  }
});

test("a resumed run confirms the base on the forge before building its step registry", async () => {
  const parked = await runParkedTicket();
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(parked.dumpDir, "..", "..", "..");
  try {
    const db = new Database(join(parked.dumpDir, "run.db"));
    const repo = (db.query("SELECT target_repo FROM project").get() as { target_repo: string })
      .target_repo;
    db.close();
    const profile = parseProfile({
      slug: parked.slug,
      targetRepo: repo,
      defaultBranch: "master",
      checksSystem: "none",
    });
    let baseAtRegistry: string | undefined;
    await expect(
      resumeRun({ resume: parked.ident }, profile, DEFAULT_RUNTIME_CONFIG, {
        ports: {
          issueTracker: fakeIssueTracker(),
          forge: fakeForge({ defaultBranch: "main", branches: ["main"] }),
        },
        preflight: () => ({ ok: true, version: null }),
        buildRegistry: () => {
          baseAtRegistry = profile.defaultBranch;
          throw new Error("stop before dispatch");
        },
      }),
    ).rejects.toThrow("stop before dispatch");
    expect(baseAtRegistry).toBe("main");
  } finally {
    if (prevState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    else process.env.XDG_STATE_HOME = prevState;
    cleanupParkedRun(parked);
  }
});
