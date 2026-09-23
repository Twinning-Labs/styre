import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { branchNameFor } from "../../src/agent/branch.ts";
import { resumeRun } from "../../src/cli/park.ts";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { branchHeadSha } from "../../src/dispatch/worktree.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { cleanupParkedRun, runParkedTicket } from "../helpers/run-harness.ts";

// A checkpoint paused because its PR request failed (the Sphinx `base invalid` case) must retry
// that request on a plain resume, against the profile's current base — not stay failed forever
// behind the outbox's INSERT OR IGNORE idempotency key. A row for a commit the branch has moved
// past must NOT come back: re-sending it would publish stale code, and under required suites it
// would be blocked on every drain and pause the run again on every resume.
test("resume re-queues failed forge rows for the current head only, with the profile's base", async () => {
  const parked = await runParkedTicket();
  const prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(parked.dumpDir, "..", "..", "..");
  const dbPath = join(parked.dumpDir, "run.db");
  try {
    const seed = new Database(dbPath);
    const repo = (seed.query("SELECT target_repo FROM project").get() as { target_repo: string })
      .target_repo;
    const ticket = seed.query("SELECT * FROM ticket").get() as Parameters<typeof branchNameFor>[0];
    const head = branchHeadSha(repo, branchNameFor(ticket));
    expect(head).not.toBeNull();
    const failed = seed.query(
      "INSERT INTO projection_outbox (ticket_id, target, op, payload_json, idempotency_key, status, attempts, error, created_at) VALUES (?, 'forge', ?, ?, ?, 'failed', 5, 'boom', '2026-09-20T00:00:00Z')",
    );
    failed.run(
      parked.ticketId,
      "pr_create",
      JSON.stringify({ branch: "feat/x", base: "master", title: "t", body: "b", sourceSha: head }),
      "k:pr_create",
    );
    failed.run(
      parked.ticketId,
      "push",
      JSON.stringify({ branch: "feat/x", sha: "0".repeat(40) }),
      "k:push:old",
    );
    failed.run(
      parked.ticketId,
      "push",
      JSON.stringify({ branch: "feat/x", sha: head }),
      "k:push:head",
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
    const pushes = Object.fromEntries(
      (
        db
          .query("SELECT idempotency_key, status FROM projection_outbox WHERE op = 'push'")
          .all() as { idempotency_key: string; status: string }[]
      ).map((r) => [r.idempotency_key, r.status]),
    );
    db.close();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(JSON.parse(row.payload_json).base).toBe("main");
    expect(pushes).toEqual({ "k:push:old": "failed", "k:push:head": "pending" });
  } finally {
    if (prevState === undefined) Reflect.deleteProperty(process.env, "XDG_STATE_HOME");
    else process.env.XDG_STATE_HOME = prevState;
    cleanupParkedRun(parked);
  }
});
