import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "../../src/config/runtime-config.ts";
import { runTicket } from "../../src/daemon/run-ticket.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { makeTestDb } from "../helpers/db.ts";
import { skeletonRegistry } from "../helpers/skeleton-registry.ts";

test("runTicket ingests a Linear ticket and drives it to pr-ready", async () => {
  // makeTestDb() seeds a "test-project" slug + "ENG-1" ticket.
  // runTicket ingests a distinct slug ("demo") + ident ("ENG-42") — no UNIQUE collision.
  const { db } = makeTestDb();
  const profile = parseProfile({
    slug: "demo",
    targetRepo: "/tmp/x",
    defaultBranch: "main",
    commands: {},
    checksSystem: "none",
  });
  const ports = {
    issueTracker: fakeIssueTracker({
      ticket: {
        ident: "ENG-42",
        title: "Real title",
        description: "Real body / AC",
        typeLabel: "Bug",
        linearIssueUuid: "uuid-42",
        url: "http://x/42",
      },
    }),
    forge: fakeForge(),
    checks: fakeChecks("passing"),
  };

  const out = await runTicket({
    db,
    profile,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ports,
    registry: skeletonRegistry(),
    ticketRef: "ENG-42",
  });

  expect(out.outcome).toBe("pr-ready");
  // Ingestion persisted the fetched fields.
  const t = getTicket(db, out.ticketId);
  expect(t?.ident).toBe("ENG-42");
  expect(t?.title).toBe("Real title");
  expect(t?.description).toBe("Real body / AC");
  expect(t?.type_label).toBe("Bug");
  expect(t?.branch_prefix).toBe("fix");
  // fetchTicket was the ingestion read.
  expect(ports.issueTracker.calls.some((c) => c.method === "fetchTicket")).toBe(true);
  // Summary mentions the final stage.
  expect(out.summary).toContain("merge");
  db.close();
});
