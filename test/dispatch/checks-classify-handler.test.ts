import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { insertAcCheck, listByTicket as listAcChecks } from "../../src/db/repos/ac-check.ts";
import { insertAc } from "../../src/db/repos/acceptance-criterion.ts";
import {
  insertSignal,
  listByTicket as listSignals,
} from "../../src/db/repos/ground-truth-signal.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { runStep } from "../../src/engine/step-journal.ts";
import { makeTestDb } from "../helpers/db.ts";

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-cc-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  Bun.write(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

/** Seed one AC + one ac_check with a given coarse result and its RED-first signal, returning the
 *  ac_check id. */
function seedCheck(
  db: ReturnType<typeof makeTestDb>["db"],
  ticketId: number,
  seq: number,
  coarse: "red" | "green" | "error",
  rawOutput: string,
) {
  const ac = insertAc(db, { ticketId, seq, text: `ac ${seq}`, source: "checklist" }).id;
  const row = insertAcCheck(db, {
    ticketId,
    acId: ac,
    selector: `s${seq}`,
    testPath: `t${seq}.py`,
    redFirstResult: coarse,
  });
  insertSignal(db, {
    ticketId,
    signalType: "ac-check-red-first",
    result: coarse === "green" ? "pass" : coarse === "red" ? "fail" : "error",
    detail: {
      rawOutput,
      exitCode: coarse === "green" ? 0 : 1,
      framework: "pytest",
      command: "c",
      acCheckId: row.id,
    },
  });
  return { acId: ac, acCheckId: row.id };
}

function registryWith(repo: string, runner: FakeAgentRunner) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: parseProfile({
      slug: "demo",
      targetRepo: repo,
      components: [{ name: "api", kind: "python", paths: ["**"], commands: { test: "pytest -q" } }],
    }),
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-ccwt-")),
  });
}

test("prior settles absence/environmental; adjudicator classes an assertion-red and a green disposition", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);

  // c1: red own-symbol import error → prior settles absence (no adjudication).
  const c1 = seedCheck(
    db,
    ticketId,
    1,
    "red",
    "ImportError: cannot import name 'save_pref' from 'app.prefs'",
  );
  // c2: red assertion → adjudicate → assertion.
  const c2 = seedCheck(db, ticketId, 2, "red", "E   assert 404 == 201");
  // c3: coarse error → prior settles environmental.
  const c3 = seedCheck(db, ticketId, 3, "error", "could not attempt");
  // c4: green → adjudicate → already-satisfied.
  const c4 = seedCheck(db, ticketId, 4, "green", "1 passed");

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: `\`\`\`styre-sidecar\n${JSON.stringify({
      classifications: [
        { ac_check_id: c2.acCheckId, class: "assertion", reason: "real behavioral assert" },
        { ac_check_id: c4.acCheckId, class: "already-satisfied", reason: "met by existing code" },
      ],
    })}\n\`\`\``,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));

  const registry = registryWith(repo, runner);
  const handler = registry.resolve("checks:classify");
  if (!handler) throw new Error("checks:classify handler not registered");
  await runStep(db, {
    ticketId,
    stepKey: "checks:classify",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      handler({
        db,
        ticket: {
          id: ticketId,
          ident: "ENG-1",
          title: null,
          project_id: projectId,
          stage: "design",
        } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });

  const rows = listAcChecks(db, ticketId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  expect(byId.get(c1.acCheckId)?.red_class).toBe("absence");
  expect(byId.get(c2.acCheckId)?.red_class).toBe("assertion");
  expect(byId.get(c3.acCheckId)?.red_class).toBe("environmental");
  expect(byId.get(c4.acCheckId)?.disposition).toBe("satisfied");
  // one classification-evidence signal per check
  const cls = listSignals(db, ticketId).filter((s) => s.signal_type === "ac-check-classification");
  expect(cls.length).toBe(4);
  db.close();
});

test("a vacuous green sets NO column but records a vacuous classification signal", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const c1 = seedCheck(db, ticketId, 1, "green", "1 passed");

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: `\`\`\`styre-sidecar\n${JSON.stringify({
      classifications: [{ ac_check_id: c1.acCheckId, class: "vacuous", reason: "asserts True" }],
    })}\n\`\`\``,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryWith(repo, runner);
  const handler = registry.resolve("checks:classify");
  if (!handler) throw new Error("checks:classify handler not registered");
  await runStep(db, {
    ticketId,
    stepKey: "checks:classify",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      handler({
        db,
        ticket: {
          id: ticketId,
          ident: "ENG-1",
          title: null,
          project_id: projectId,
          stage: "design",
        } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });
  const row = listAcChecks(db, ticketId)[0];
  expect(row?.red_class).toBeNull();
  expect(row?.disposition).toBeNull();
  const vac = listSignals(db, ticketId).filter(
    (s) =>
      s.signal_type === "ac-check-classification" &&
      JSON.parse(s.detail_json ?? "{}").class === "vacuous",
  );
  expect(vac.length).toBe(1);
  db.close();
});

test("a weak verdict on a red check re-authors (no red_class persisted)", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  const c1 = seedCheck(db, ticketId, 1, "red", "E   assert response.status_code == 200");

  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: `\`\`\`styre-sidecar\n${JSON.stringify({
      classifications: [{ ac_check_id: c1.acCheckId, class: "weak", reason: "status-only" }],
    })}\n\`\`\``,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  const registry = registryWith(repo, runner);
  const handler = registry.resolve("checks:classify");
  if (!handler) throw new Error("checks:classify handler not registered");
  await runStep(db, {
    ticketId,
    stepKey: "checks:classify",
    stepType: "dispatch",
    effectful: true,
    execute: (step) =>
      handler({
        db,
        ticket: {
          id: ticketId,
          ident: "ENG-1",
          title: null,
          project_id: projectId,
          stage: "design",
        } as never,
        step,
        workUnitId: null,
        config: undefined as never,
      }),
  });
  const row = listAcChecks(db, ticketId)[0];
  expect(row?.red_class).toBeNull();
  expect(row?.disposition).toBeNull();
  const sig = listSignals(db, ticketId).find(
    (s) =>
      s.signal_type === "ac-check-classification" &&
      JSON.parse(s.detail_json ?? "{}").class === "weak",
  );
  expect(sig?.result).toBe("fail");
  db.close();
});
