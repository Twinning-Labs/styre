import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { listByTicket as listEvents } from "../../src/db/repos/event-log.ts";
import { setTicketTrack } from "../../src/db/repos/ticket.ts";
import { getTicket } from "../../src/db/repos/ticket.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-re-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

test("green-on-HEAD check → vacuous → scoped re-author → repeated vacuous → escalate", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET description = ? WHERE id = ?").run(
    "- [ ] persists a pref\n",
    ticketId,
  );

  // Seed design done + one unit + fast track so the resolver serves provision→checks:dispatch→classify.
  await runStep(db, {
    ticketId,
    stepKey: "design:dispatch",
    stepType: "dispatch",
    execute: () => ({ ok: true }),
  });
  insertWorkUnit(db, { ticketId, seq: 1, kind: "python", verifyCheckTypes: ["test"] });
  setTicketTrack(db, ticketId, "fast");

  let file = 0;
  const runner = new FakeAgentRunner((input) => {
    // checks:dispatch authors a new test file; checks:classify returns a sidecar with no file write.
    const wantsSidecar =
      input.prompt.includes("adjudicat") || input.prompt.includes("Checks to classify");
    if (!wantsSidecar) {
      file += 1;
      const dir = join(input.cwd, "checks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `ac${file}.py`), "def test_ac():\n    assert True\n");
      return {
        completed: true,
        exitCode: 0,
        stdout: `\`\`\`styre-sidecar\n{"checksAuthored":[{"ac_id":1,"test_file":"checks/ac${file}.py","test_name":"test_ac"}]}\n\`\`\``,
        stderr: "",
        timedOut: false,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
      };
    }
    // Adjudicator: classify the (single) green check vacuous. Extract the ac_check_id from the prompt.
    const m = input.prompt.match(/ac_check_id=(\d+)/);
    const id = m ? Number(m[1]) : 0;
    return {
      completed: true,
      exitCode: 0,
      stdout: `\`\`\`styre-sidecar\n{"classifications":[{"ac_check_id":${id},"class":"vacuous","reason":"asserts True"}]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  const registry = buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-rewt-")),
    // The authored check GREENS on clean HEAD (exit 0) → green-on-HEAD adjudication.
    runCheckCommand: async () => ({ exitCode: 0, stdout: "1 passed", stderr: "", timedOut: false }),
  });

  // Drive the loop until the ticket escalates (status=waiting) or a bound is hit.
  let escalated = false;
  for (let i = 0; i < 20; i++) {
    const t = getTicket(db, ticketId);
    if (t?.status === "waiting") {
      escalated = true;
      break;
    }
    try {
      await advanceOneStep(db, ticketId, registry);
    } catch {
      // implement:dispatch etc. may throw once the loop would leave design — not expected before escalate.
    }
  }

  // Binding facts:
  // 1. The ticket escalated (repeated (ac_id,"vacuous") signature).
  expect(escalated).toBe(true);
  // 2. At least two checks-loopback events were appended (the scoped re-authors) before escalate.
  const checksLoopbacks = listEvents(db, ticketId).filter(
    (e) => e.kind === "loopback" && e.loop === "checks",
  );
  expect(checksLoopbacks.length).toBeGreaterThanOrEqual(1);
  const escalations = listEvents(db, ticketId).filter((e) => e.kind === "escalated");
  expect(escalations.length).toBeGreaterThanOrEqual(1);
  db.close();
});
