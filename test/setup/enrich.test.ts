import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import type { AgentRunResult } from "../../src/agent/runner.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { RuntimeContextSchema } from "../../src/dispatch/profile.ts";
import { enrichRuntimeContext } from "../../src/setup/enrich.ts";

const scan = (o: unknown) => RuntimeContextSchema.parse(o);
const ok = (stdout: string): AgentRunResult => ({
  completed: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
  costUsd: null,
  tokensIn: null,
  tokensOut: null,
});
const sidecar = (json: string) => `Here you go.\n\`\`\`styre-setup-enrich\n${json}\n\`\`\`\n`;
const noSleep = () => Promise.resolve();

const FULL = {
  topology: { detail: "a cli" },
  data: { detail: "no db" },
  caching: { detail: "no cache" },
  observability: { detail: "pino logs" },
  configSecrets: { detail: "env vars" },
  documentation: { detail: "README + docs/" },
  releasePackaging: { detail: "semantic-release" },
};

test("enrich merges agent prose over the scan", async () => {
  const runner = new FakeAgentRunner(() =>
    ok(sidecar(JSON.stringify({ ...FULL, caching: { detail: "Redis, 15m TTL" } }))),
  );
  const out = await enrichRuntimeContext(
    "/tmp/repo",
    scan({ caching: { presence: "present", detail: "ioredis" } }),
    { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: noSleep },
  );
  expect(out.caching.detail).toBe("Redis, 15m TTL");
  expect(out.caching.presence).toBe("present");
});

test("enrich resolves an unknown section from the agent proposal", async () => {
  const runner = new FakeAgentRunner(() =>
    ok(
      sidecar(
        JSON.stringify({
          ...FULL,
          data: { presence: "present", migrationTool: "prisma", detail: "pg" },
        }),
      ),
    ),
  );
  const out = await enrichRuntimeContext("/tmp/repo", scan({ data: { presence: "unknown" } }), {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: noSleep,
  });
  expect(out.data.presence).toBe("present");
  expect(out.data.migrationTool).toBe("prisma");
});

test("enrich passes read-only tools and the standard-tier model, cwd=repoDir", async () => {
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(FULL))));
  await enrichRuntimeContext("/tmp/repo", scan({}), {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: noSleep,
  });
  const input = runner.inputs[0];
  expect(input?.allowedTools).toEqual(["Read", "Grep", "Glob"]);
  expect(input?.model).toBe("claude-sonnet-4-6");
  expect(input?.cwd).toBe("/tmp/repo");
});

test("enrich retries a malformed sidecar then throws after 3 attempts", async () => {
  const runner = new FakeAgentRunner(() => ok("no sidecar here"));
  await expect(
    enrichRuntimeContext("/tmp/repo", scan({}), {
      runner,
      agentConfig: DEFAULT_AGENT_CONFIG,
      sleep: noSleep,
    }),
  ).rejects.toThrow(/failed after 3 attempts/);
  expect(runner.inputs.length).toBe(3);
});

test("enrich retries a non-completed result then succeeds on a later attempt", async () => {
  let n = 0;
  const runner = new FakeAgentRunner((): AgentRunResult => {
    n += 1;
    if (n < 2) return { ...ok(""), completed: false, exitCode: 1 };
    return ok(sidecar(JSON.stringify(FULL)));
  });
  const out = await enrichRuntimeContext("/tmp/repo", scan({}), {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: noSleep,
  });
  expect(out.topology.detail).toBe("a cli");
  expect(runner.inputs.length).toBe(2);
});

test("enrich injects manifest dependency names into the prompt", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-enrich-deps-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ dependencies: { "drizzle-orm": "^0.30" } }),
  );
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(FULL))));
  await enrichRuntimeContext(repo, scan({}), {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: noSleep,
  });
  expect(runner.inputs[0]?.prompt).toContain("drizzle-orm");
});

test("enrich still renders when the repo has no manifests", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-enrich-empty-"));
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(FULL))));
  const out = await enrichRuntimeContext(repo, scan({}), {
    runner,
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: noSleep,
  });
  expect(out.topology.detail).toBe("a cli");
  expect(runner.inputs[0]?.prompt).toContain("(no dependency manifests detected)");
});
