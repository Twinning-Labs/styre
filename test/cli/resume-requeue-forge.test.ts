import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { cleanupParkedRun, runParkedTicket } from "../helpers/run-harness.ts";

// A checkpoint paused because its PR request failed (the Sphinx `base invalid` case) must retry
// that request on a plain resume, against the profile's current base — not stay failed forever
// behind the outbox's INSERT OR IGNORE idempotency key.
test("resume re-queues a failed PR request with the profile's current base", async () => {
  const parked = await runParkedTicket();
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(parked.dumpDir, "..", "..", "..");
  const dbPath = join(parked.dumpDir, "run.db");
  try {
    const seed = new Database(dbPath);
    const repo = (seed.query("SELECT target_repo FROM project").get() as { target_repo: string })
      .target_repo;
    seed
      .query(
        "INSERT INTO projection_outbox (ticket_id, target, op, payload_json, idempotency_key, status, attempts, error, created_at) VALUES (?, 'forge', 'pr_create', ?, 'k:pr_create', 'failed', 1, 'GitHub Validation Failed: PullRequest base invalid', '2026-09-20T00:00:00Z')",
      )
      .run(
        parked.ticketId,
        JSON.stringify({
          branch: "feat/x",
          base: "master",
          title: "t",
          body: "b",
          sourceSha: null,
        }),
      );
    seed.close();
    await expect(
      resumeRun(
        { resume: parked.ident },
        parseProfile({
          slug: parked.slug,
          targetRepo: repo,
          defaultBranch: "main",
          checksSystem: "none",
        }),
        DEFAULT_RUNTIME_CONFIG,
        {
          ports: { issueTracker: fakeIssueTracker(), forge: fakeForge() },
          preflight: () => ({ ok: true, version: null }),
          buildRegistry: () => {
            throw new Error("stop before dispatch");
          },
        },
      ),
    ).rejects.toThrow("stop before dispatch");
    const db = new Database(dbPath);
    const row = db
      .query("SELECT status, attempts, payload_json FROM projection_outbox WHERE op = 'pr_create'")
      .get() as { status: string; attempts: number; payload_json: string };
    db.close();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(JSON.parse(row.payload_json).base).toBe("main");
  } finally {
    if (prevState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    else process.env.XDG_STATE_HOME = prevState;
    cleanupParkedRun(parked);
  }
});
