import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { advanceOneStep } from "../../src/daemon/advance.ts";
import { insertWorkUnit } from "../../src/db/repos/work-unit.ts";
import { buildDispatchRegistry } from "../../src/dispatch/handlers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { makeTestDb } from "../helpers/db.ts";

/** Shared rust+fe profile: rust paths src-tauri/**, fe paths src/** */
const RUST_FE_PROFILE = parseProfile({
  slug: "rust-fe",
  targetRepo: "/tmp/repo",
  components: [
    {
      name: "rust",
      kind: "backend",
      paths: ["src-tauri/**"],
      commands: { build: "cargo build", test: "cargo test" },
    },
    {
      name: "fe",
      kind: "frontend",
      paths: ["src/**"],
      commands: { build: "vite build", test: { unavailable: true } },
    },
  ],
});

/** Profile where every command is unavailable — no real runner strings. */
const ALL_UNAVAILABLE_PROFILE = parseProfile({
  slug: "noop",
  targetRepo: "/tmp/repo",
  components: [
    {
      name: "lib",
      kind: "library",
      paths: ["**"],
      commands: { build: { unavailable: true }, test: { unavailable: true } },
    },
  ],
});

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-ial-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["config", "user.email", "t@s.dev"]);
  run(["config", "user.name", "T"]);
  writeFileSync(join(root, "README.md"), "x");
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return root;
}

function registryFor(repo: string, runner: FakeAgentRunner, profile = RUST_FE_PROFILE) {
  return buildDispatchRegistry({
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    profile: { ...profile, targetRepo: repo },
    worktreeRoot: mkdtempSync(join(tmpdir(), "styre-ialwt-")),
  });
}

test("implement: touching rust file → scoped to cargo, NOT vite/playwright, no bare Bash", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    filesToTouch: ["src-tauri/lib.rs"],
    verifyCheckTypes: ["test"],
  });

  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "src-tauri-impl.ts"), "export const x = 1;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["src-tauri-impl.ts"]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  db.close();

  const allowedTools = runner.inputs[0]?.allowedTools ?? [];
  expect(allowedTools).toContain("Bash(cargo build:*)");
  expect(allowedTools).toContain("Bash(cargo test:*)");
  expect(allowedTools).not.toContain("Bash(vite build:*)");
  expect(allowedTools).not.toContain("Bash");
  // No object artifacts
  expect(allowedTools.join(",")).not.toContain("[object");
});

test("implement: empty filesToTouch → scoped union fallback (cargo+vite), still no bare Bash", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    filesToTouch: [],
    verifyCheckTypes: ["test"],
  });

  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "impl.ts"), "export const y = 2;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["impl.ts"]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  await advanceOneStep(db, ticketId, registryFor(repo, runner));
  db.close();

  const allowedTools = runner.inputs[0]?.allowedTools ?? [];
  // Falls back to union of all components' real commands
  expect(allowedTools).toContain("Bash(cargo build:*)");
  expect(allowedTools).toContain("Bash(cargo test:*)");
  expect(allowedTools).toContain("Bash(vite build:*)");
  // Still no bare Bash
  expect(allowedTools).not.toContain("Bash");
  expect(allowedTools.join(",")).not.toContain("[object");
});

test("implement: all-unavailable profile → NO Bash token at all, Write/Edit still present", async () => {
  const { db, ticketId, projectId } = makeTestDb();
  const repo = gitRepo();
  db.query("UPDATE project SET target_repo = ? WHERE id = ?").run(repo, projectId);
  db.query("UPDATE ticket SET stage = 'implement' WHERE id = ?").run(ticketId);
  insertWorkUnit(db, {
    ticketId,
    seq: 1,
    kind: "backend",
    verifyCheckTypes: [],
  });

  const runner = new FakeAgentRunner((input) => {
    writeFileSync(join(input.cwd, "impl.ts"), "export const z = 3;\n");
    return {
      completed: true,
      exitCode: 0,
      stdout: `{}\n\`\`\`styre-sidecar\n{"new_files":["impl.ts"]}\n\`\`\``,
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    };
  });

  await advanceOneStep(db, ticketId, registryFor(repo, runner, ALL_UNAVAILABLE_PROFILE));
  db.close();

  const allowedTools = runner.inputs[0]?.allowedTools ?? [];
  // No Bash at all — not bare, not scoped
  expect(allowedTools).not.toContain("Bash");
  expect(allowedTools.some((t) => t.startsWith("Bash("))).toBe(false);
  // Write and Edit must still be present
  expect(allowedTools).toContain("Write");
  expect(allowedTools).toContain("Edit");
});
