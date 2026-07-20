import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgentRunner } from "../../src/agent/fake-runner.ts";
import { runSetup, unknownRuntimeSections } from "../../src/cli/setup.ts";
import { DEFAULT_AGENT_CONFIG } from "../../src/config/agent-config.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import type { EnrichDeps } from "../../src/setup/enrich.ts";

// A no-op enrichment: emits all sections with empty detail and no presence proposals, so the
// merge leaves the deterministic scan unchanged (keeps existing setup assertions valid).
const NOOP_ENRICH = {
  topology: { detail: "" },
  data: { detail: "" },
  caching: { detail: "" },
  observability: { detail: "" },
  configSecrets: { detail: "" },
  documentation: { detail: "" },
  releasePackaging: { detail: "" },
};
function fakeDeps(enrichment: unknown = NOOP_ENRICH): EnrichDeps {
  const runner = new FakeAgentRunner(() => ({
    completed: true,
    exitCode: 0,
    stdout: `\`\`\`styre-setup-enrich\n${JSON.stringify(enrichment)}\n\`\`\``,
    stderr: "",
    timedOut: false,
    costUsd: null,
    tokensIn: null,
    tokensOut: null,
  }));
  return { runner, agentConfig: DEFAULT_AGENT_CONFIG, sleep: () => Promise.resolve() };
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "styre-setup-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root });
  run(["init", "-b", "main"]);
  run(["remote", "add", "origin", "git@github.com:acme/widget.git"]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  return root;
}

test("runSetup probes and writes a valid profile to --out", async () => {
  const repo = gitRepo();
  const out = join(mkdtempSync(join(tmpdir(), "styre-out-")), "profile.json");
  const { outPath, profile } = await runSetup({ repo, out, deps: fakeDeps() });
  expect(outPath).toBe(out);
  expect(profile.slug).toBe("widget");
  // The written file round-trips through parseProfile.
  expect(parseProfile(JSON.parse(readFileSync(out, "utf8"))).slug).toBe("widget");
});

test("runSetup defaults the path to configDir()/<slug>/profile.json", async () => {
  const repo = gitRepo();
  const cfg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = cfg;
  try {
    const { outPath } = await runSetup({ repo, deps: fakeDeps() });
    expect(outPath).toBe(join(cfg, "styre", "widget", "profile.json"));
    expect(existsSync(outPath)).toBe(true);
  } finally {
    if (prev === undefined)
      // biome-ignore lint/performance/noDelete: process.env must be unset via delete; assigning undefined leaves the string "undefined"
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("re-running setup preserves an operator-resolved section", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");

  await runSetup({ repo, out, deps: fakeDeps() }); // first probe → caching unknown
  // operator fills caching by hand:
  const p = JSON.parse(readFileSync(out, "utf8"));
  p.runtimeContext.caching = { presence: "present", detail: "redis (operator)" };
  writeFileSync(out, JSON.stringify(p));

  const { profile } = await runSetup({ repo, out, deps: fakeDeps() }); // re-run merges
  expect(profile.runtimeContext.caching.presence).toBe("present");
  expect(profile.runtimeContext.caching.detail).toBe("redis (operator)");
});

test("--reprobe discards operator edits", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  await runSetup({ repo, out, deps: fakeDeps() });
  const p = JSON.parse(readFileSync(out, "utf8"));
  p.runtimeContext.caching = { presence: "present", detail: "redis (operator)" };
  writeFileSync(out, JSON.stringify(p));
  const { profile } = await runSetup({ repo, out, reprobe: true, deps: fakeDeps() });
  expect(profile.runtimeContext.caching.presence).toBe("unknown");
});

test("--force discards operator edits", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  await runSetup({ repo, out, deps: fakeDeps() });
  const p = JSON.parse(readFileSync(out, "utf8"));
  p.runtimeContext.caching = { presence: "present", detail: "redis (operator)" };
  writeFileSync(out, JSON.stringify(p));
  const { profile } = await runSetup({ repo, out, force: true, deps: fakeDeps() });
  expect(profile.runtimeContext.caching.presence).toBe("unknown");
});

test("runSetup writes the agent-enriched detail into the profile", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  const enrichment = { ...NOOP_ENRICH, documentation: { detail: "README + docs/ with mkdocs" } };
  const { profile } = await runSetup({ repo, out, deps: fakeDeps(enrichment) });
  expect(profile.runtimeContext.documentation.detail).toBe("README + docs/ with mkdocs");
});

test("re-probe failure leaves existing file byte-unchanged", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  await runSetup({ repo, out, deps: fakeDeps() });
  const before = readFileSync(out, "utf8");
  const failing: EnrichDeps = {
    runner: new FakeAgentRunner(() => ({
      completed: true,
      exitCode: 0,
      stdout: "no sidecar",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    })),
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: () => Promise.resolve(),
  };
  await expect(runSetup({ repo, out, reprobe: true, deps: failing })).rejects.toThrow(
    /failed after 3 attempts/,
  );
  expect(readFileSync(out, "utf8")).toBe(before);
});

test("runSetup throws and writes no profile when enrichment fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-repo-"));
  writeFileSync(join(repo, "package.json"), "{}");
  const out = join(mkdtempSync(join(tmpdir(), "styre-cfg-")), "profile.json");
  const failing: EnrichDeps = {
    runner: new FakeAgentRunner(() => ({
      completed: true,
      exitCode: 0,
      stdout: "no sidecar",
      stderr: "",
      timedOut: false,
      costUsd: null,
      tokensIn: null,
      tokensOut: null,
    })),
    agentConfig: DEFAULT_AGENT_CONFIG,
    sleep: () => Promise.resolve(),
  };
  await expect(runSetup({ repo, out, deps: failing })).rejects.toThrow(/failed after 3 attempts/);
  expect(existsSync(out)).toBe(false);
});

// ─── WO-3 Task 1: confirm-block prepare line ─────────────────────────────────

test("interactive confirm block prints prepare line for components that carry it", async () => {
  // Set up a ruby-only git repo (Gemfile + .rspec → ruby component with prepare: "bundle install")
  const repo = mkdtempSync(join(tmpdir(), "styre-setup-ruby-"));
  const run = (a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo });
  run(["init", "-b", "main"]);
  run(["remote", "add", "origin", "git@github.com:acme/myapp.git"]);
  writeFileSync(join(repo, "Gemfile"), "source 'https://rubygems.org'\ngem 'rspec'\n");
  writeFileSync(join(repo, ".rspec"), "--format documentation\n");

  const out = join(mkdtempSync(join(tmpdir(), "styre-out-ruby-")), "profile.json");

  // Capture stderr output (setup's human output moved from console.log to process.stderr.write)
  const logs: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  // Mock globalThis.prompt: return "" for missing-command prompts (→ unavailable),
  // return "y" for the approval prompt.
  const origPrompt = globalThis.prompt;
  (globalThis as Record<string, unknown>).prompt = (q: string) =>
    q?.includes("Approve") ? "y" : "";

  // Make the runSetup loop see interactive = true
  const origDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    configurable: true,
    writable: true,
  });

  try {
    await runSetup({ repo, out, deps: fakeDeps() });
    // The confirm block must print a "prepare: bundle install (stored, not run)" line
    expect(
      logs.some(
        (l) =>
          l.includes("prepare:") && l.includes("bundle install") && l.includes("stored, not run"),
      ),
    ).toBe(true);
  } finally {
    process.stderr.write = origStderrWrite;
    (globalThis as Record<string, unknown>).prompt = origPrompt;
    if (origDescriptor !== undefined) {
      Object.defineProperty(process.stdin, "isTTY", origDescriptor);
    } else {
      // biome-ignore lint/performance/noDelete: restoring undefined property requires delete
      delete (process.stdin as unknown as Record<string, unknown>).isTTY;
    }
  }
});

test("unknownRuntimeSections lists only the unknown flags", () => {
  const p = parseProfile({
    slug: "d",
    targetRepo: "/t",
    runtimeContext: {
      topology: { type: "web-service" },
      data: { presence: "present" },
      caching: { presence: "unknown" },
      observability: { presence: "unknown" },
      documentation: { presence: "present" },
    },
  });
  const u = unknownRuntimeSections(p);
  expect(u).toContain("caching");
  expect(u).toContain("observability");
  expect(u).toContain("configSecrets"); // defaulted unknown
  expect(u).not.toContain("data");
  expect(u).not.toContain("topology");
});
