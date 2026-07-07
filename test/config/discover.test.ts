import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRuntimeConfig,
  loadProfileByConvention,
  profilePathFor,
  slugForCwd,
} from "../../src/config/discover.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "styre-cfghome-"));
}
function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
}
const AGENT = {
  provider: "codex",
  command: "codex",
  models: { deep: "d", standard: "s", cheap: "c" },
};

test("explicit --config is hermetic — convention files are ignored", () => {
  const home = freshHome();
  writeJson(join(home, "config.json"), { telemetry: false, agent: AGENT }); // must be ignored
  const explicit = join(freshHome(), "explicit.json");
  writeJson(explicit, { telemetry: true });
  const cfg = discoverRuntimeConfig({ explicitPath: explicit, slug: "x", configHome: home });
  expect(cfg.telemetry).toBe(true);
  expect(cfg.agent).toBeUndefined();
});

test("no --config: per-project overrides global, shallow per top-level key", () => {
  const home = freshHome();
  writeJson(join(home, "config.json"), { telemetry: false, agent: AGENT });
  writeJson(join(home, "widget", "config.json"), { telemetry: true }); // overrides only telemetry
  const cfg = discoverRuntimeConfig({ slug: "widget", configHome: home });
  expect(cfg.telemetry).toBe(true); // per-project wins
  expect(cfg.agent?.provider).toBe("codex"); // global agent survives (per-project omitted the key)
});

test("no convention files → binary defaults", () => {
  const cfg = discoverRuntimeConfig({ slug: "none", configHome: freshHome() });
  expect(cfg.telemetry).toBe(true); // RuntimeConfig default
  expect(cfg.agent).toBeUndefined();
});

test("a partial agent block is a hard error (agent is all-or-nothing)", () => {
  const home = freshHome();
  writeJson(join(home, "config.json"), { agent: { provider: "codex" } }); // missing models
  expect(() => discoverRuntimeConfig({ slug: "x", configHome: home })).toThrow();
});

test("a malformed convention file throws naming the file", () => {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), "{ not json");
  expect(() => discoverRuntimeConfig({ slug: "x", configHome: home })).toThrow(/config\.json/);
});

test("loadProfileByConvention: ENOENT → run-setup error; present → loads", () => {
  const home = freshHome();
  expect(() => loadProfileByConvention("ghost", home)).toThrow(/run `styre setup` first/);
  const p = {
    slug: "widget",
    targetRepo: "/tmp/x",
    defaultBranch: "main",
    checksSystem: "none",
    components: [],
    repoCommands: {},
    runtimeContext: {},
  };
  writeJson(profilePathFor("widget", home), p);
  expect(loadProfileByConvention("widget", home).slug).toBe("widget");
});

test("slugForCwd returns null off-repo and the slug in a repo (injected git)", () => {
  expect(
    slugForCwd("/nope", () => {
      throw new Error("not a repo");
    }),
  ).toBeNull();
  const fakeGit = (args: string[]) => (args[0] === "rev-parse" ? "/repo/acme-widget" : "");
  // injected git returns the (fabricated, nonexistent) toplevel; deriveSlug's REAL `git config`
  // then runs in that missing dir → hardened tryGit catches the spawn ENOENT → null → basename fallback
  expect(slugForCwd("/anything", fakeGit)).toBe("acme-widget");
});
