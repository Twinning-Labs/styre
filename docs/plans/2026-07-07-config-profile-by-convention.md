# Config & Profile by Convention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `styre run` work with zero path flags by discovering the profile (run) and workspace config (run + setup) from their conventional XDG locations under `configDir()`, while keeping explicit `--profile`/`--config` as hermetic overrides.

**Architecture:** A new leaf module `src/config/slug.ts` holds the dependency-free slug/repo/remote helpers (extracted from `probe.ts`/`in-place.ts`/`github.ts`); a new `src/config/discover.ts` resolves profile + runtime config by convention (global `config.json` + per-slug override, shallow per-key merge; explicit paths hermetic). `run.ts`/`setup.ts` call the resolver instead of parsing `--config`/`--profile` inline. No schema changes.

**Tech Stack:** TypeScript + Bun (`bun test`, `bun:test`), zod, citty. No new dependencies.

**Spec:** `docs/brainstorms/2026-07-07-config-profile-by-convention-design.md` (DEC-CV-1..6).

## Global Constraints

- **Runtime/test:** Bun. Tests use `import { expect, test } from "bun:test"` under `test/` mirroring `src/`. Run one file: `bun test test/<path>.test.ts`. Full suite: `bun test`.
- **Gates green after every task:** `bun test`, `bun run typecheck`, `bun run lint`. Baseline before Task 1: full suite green (run `bun install` first — worktrees have no `node_modules`).
- **`configDir()`** = `$XDG_CONFIG_HOME/styre` (default `~/.config/styre`), overridable via `XDG_CONFIG_HOME` — the test seam so nothing touches real `~/.config`.
- **Conventional layout** (DEC-CV-1): `~/.config/styre/config.json` (global config), `~/.config/styre/<slug>/config.json` (per-project config), `~/.config/styre/<slug>/profile.json` (profile, written by setup).
- **Precedence** (no `--config`): per-project `<slug>/config.json` > global `config.json` > binary defaults. Shallow per-top-level-key merge; the `agent` block is replaced wholesale and must be complete when present.
- **Hermetic explicit flags** (DEC-CV-4): `--config <path>` = sole runtime-config source (skip discovery); `--profile <path>` = exact profile. Independent axes; existing `run --profile P --config C` behaves exactly as today.
- **`config/` stays a leaf** (DEC-CV-6): `slug.ts`/`discover.ts` must not import the heavy `probe.ts`/`in-place.ts`/`github.ts`; those re-export from `slug.ts` instead.
- **Lock-in invariant:** `@octokit` stays imported only in `src/integrations/adapters/github.ts` (asserted by `test/integrations/lockin.test.ts`). Moving the pure `parseGitHubRemote` out does not add an `@octokit` import elsewhere.
- **Workflow:** branch `feat/config-by-convention` (pushed, PR #55). No commits to `main`, no auto-merge, operator merges. Conventional-Commits PR title. TDD (failing test first); commit per task.

---

### Task 1: Extract the `config/slug.ts` leaf (deriveSlug, discoverRepoRoot, parseGitHubRemote)

Move the three dependency-free helpers into one leaf module so `discover.ts` (Task 2) — and an eager import from `run.ts` — never pull `probe.ts`/`in-place.ts`/`github.ts`'s heavy transitive deps. Pure refactor: behavior unchanged, existing tests stay green (this also closes the known "lift parseGitHubRemote to an SDK-free module" carry).

**Files:**
- Create: `src/config/slug.ts`
- Modify: `src/integrations/adapters/github.ts` (drop the `parseGitHubRemote` definition; import + re-export it from `slug.ts`)
- Modify: `src/setup/probe.ts` (drop local `tryGit`/`deriveSlug` + the github import; import them from `slug.ts`)
- Modify: `src/dispatch/in-place.ts` (drop `GitRun`/`defaultGit`/`discoverRepoRoot`; import from `slug.ts`; re-export `discoverRepoRoot`)
- Test: `test/config/slug.test.ts` (new)

**Interfaces (produced by `src/config/slug.ts`, all exported):**
- `tryGit(args: string[], cwd: string): string | null`
- `parseGitHubRemote(url: string): { owner: string; repo: string } | null`
- `deriveSlug(repoDir: string): string`
- `type GitRun = (args: string[], cwd: string) => string`; `defaultGit: GitRun`
- `discoverRepoRoot(cwd?: string, git?: GitRun): string` (throws on non-repo — message unchanged, contains "no git repo")

- [ ] **Step 1: Write the failing test** — `test/config/slug.test.ts`

```ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deriveSlug, discoverRepoRoot, parseGitHubRemote } from "../../src/config/slug.ts";

test("parseGitHubRemote handles SSH/HTTPS and rejects non-GitHub", () => {
  expect(parseGitHubRemote("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  expect(parseGitHubRemote("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  expect(parseGitHubRemote("https://gitlab.com/o/r.git")).toBeNull();
});

test("deriveSlug uses the origin repo name, else the dir basename", () => {
  const noRemote = mkdtempSync(join(tmpdir(), "styre-slug-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: noRemote });
  expect(deriveSlug(noRemote)).toBe(basename(noRemote)); // no origin → basename
  const withRemote = mkdtempSync(join(tmpdir(), "styre-slug-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: withRemote });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: withRemote });
  expect(deriveSlug(withRemote)).toBe("widget");
});

test("discoverRepoRoot returns the toplevel and throws off-repo", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-root-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  expect(discoverRepoRoot(repo).endsWith(basename(repo))).toBe(true);
  const notRepo = mkdtempSync(join(tmpdir(), "styre-notrepo-"));
  expect(() => discoverRepoRoot(notRepo)).toThrow(/no git repo/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/config/slug.test.ts`
Expected: FAIL — `src/config/slug.ts` does not exist.

- [ ] **Step 3: Create `src/config/slug.ts`** (verbatim; the bodies are moved unchanged from `probe.ts`/`in-place.ts`/`github.ts`)

```ts
import { basename } from "node:path";

/** Run git in `cwd`, returning trimmed stdout, or null on ANY failure (probe-graceful). The
 *  try/catch matters: `Bun.spawnSync` THROWS (not `{success:false}`) when `cwd` does not exist, so
 *  an unguarded call would propagate — this honors the "null on any failure" contract and keeps
 *  `slugForCwd`/`deriveSlug` robust when the resolved repo dir is missing/fabricated. */
export function tryGit(args: string[], cwd: string): string | null {
  try {
    const res = Bun.spawnSync(["git", ...args], { cwd });
    return res.success ? res.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** Parse a GitHub remote URL into { owner, repo }, or null. Pure/SDK-free so slug derivation
 *  never pulls the @octokit adapter. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp) return { owner: scp[1], repo: scp[2] };
  const proto = /^(?:https?|ssh|git):\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (proto) return { owner: proto[1], repo: proto[2] };
  return null;
}

/** Slug from the origin remote's repo name, else the dir basename. */
export function deriveSlug(repoDir: string): string {
  const url = tryGit(["config", "--get", "remote.origin.url"], repoDir);
  const parsed = url ? parseGitHubRemote(url) : null;
  return parsed?.repo ?? basename(repoDir);
}

export type GitRun = (args: string[], cwd: string) => string;
export const defaultGit: GitRun = (args, cwd) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};

/** cwd's git top-level, or throw (fail-closed). Message unchanged from in-place.ts. */
export function discoverRepoRoot(cwd: string = process.cwd(), git: GitRun = defaultGit): string {
  try {
    return git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new Error(
      `--in-place: no git repo at the working directory ${cwd}; launch with WORKDIR / docker -w set to the checkout.`,
    );
  }
}
```

- [ ] **Step 4: Rewire the three source files**

`src/integrations/adapters/github.ts` — remove the `parseGitHubRemote` function definition (currently ~lines 47-58; leave the internal call site at ~line 73 intact) and add, right after the existing imports (below the `import { Octokit }` line):

```ts
import { parseGitHubRemote } from "../../config/slug.ts";
export { parseGitHubRemote }; // re-exported so existing importers (probe, tests) are unchanged
```

Also trim the now-stale prose that described the moved function: the header line "The pure `parseGitHubRemote` helper below is …" (~line 12) and the doc-comment block that sat above the old definition (~lines 41-46). Leave the internal call site (`const parsed = parseGitHubRemote(remoteUrl);`, ~line 73) intact.

`src/setup/probe.ts` — remove the local `tryGit` (lines ~8-12) and `deriveSlug` (lines ~14-19) definitions and the `import { parseGitHubRemote } from "../integrations/adapters/github.ts";` line; add `import { deriveSlug, tryGit } from "../config/slug.ts";`. **Also drop `basename` from the node:path import** — it was used only inside the now-removed `deriveSlug`, and `tsconfig.json` has `"noUnusedLocals": true`, so leaving it fails `bun run typecheck` (TS6133). Line 1 becomes:

```ts
import { resolve } from "node:path";
```
(`detectDefaultBranch` keeps using the imported `tryGit`; `probeProfile` keeps using `resolve`.)

`src/dispatch/in-place.ts` — remove the local `type GitRun`, `defaultGit`, and `discoverRepoRoot` (lines ~14-29); add near the top:

```ts
import { type GitRun, defaultGit, discoverRepoRoot } from "../config/slug.ts";
export { discoverRepoRoot }; // re-export: run.ts/setup.ts lazy-import it from here
```
(`assertInPlaceSafe`/`assertInPlaceIdentity` keep using the imported `defaultGit`/`GitRun`.)

- [ ] **Step 5: Run the full suite + gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS — `slug.test.ts` green; `test/integrations/github-adapter.test.ts` (imports `parseGitHubRemote` from `github.ts` via the re-export), `test/integrations/lockin.test.ts` (@octokit still only in `github.ts`), and all `in-place`/`setup`/`probe` tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/config/slug.ts src/integrations/adapters/github.ts src/setup/probe.ts src/dispatch/in-place.ts test/config/slug.test.ts
git commit -m "refactor(config): extract slug/repo/remote helpers into config/slug.ts leaf"
```

---

### Task 2: `config/discover.ts` — profile + runtime-config discovery-by-convention

The resolution layer. Pure, no wiring. `configHome` is injectable (defaults to `configDir()`) so tests never touch real `~/.config`.

**Files:**
- Create: `src/config/discover.ts`
- Test: `test/config/discover.test.ts`

**Interfaces (produced, all exported):**
- `slugForCwd(cwd?: string, git?: GitRun): string | null` — repo slug for cwd, or `null` off-repo.
- `profilePathFor(slug: string, configHome?: string): string`
- `loadProfileByConvention(slug: string, configHome?: string): Profile` — throws a setup-pointing error on ENOENT; a malformed profile's parse error propagates unchanged.
- `discoverRuntimeConfig(opts: { explicitPath?: string; slug?: string; configHome?: string }): RuntimeConfig` — explicit path hermetic; else shallow-merge global + per-slug raw JSON then `.parse()`.

- [ ] **Step 1: Write the failing test** — `test/config/discover.test.ts`

```ts
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
const AGENT = { provider: "codex", command: "codex", models: { deep: "d", standard: "s", cheap: "c" } };

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
  expect(cfg.telemetry).toBe(true);          // per-project wins
  expect(cfg.agent?.provider).toBe("codex"); // global agent survives (per-project omitted the key)
});

test("no convention files → binary defaults", () => {
  const cfg = discoverRuntimeConfig({ slug: "none", configHome: freshHome() });
  expect(cfg.telemetry).toBe(true);   // RuntimeConfig default
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
  const p = { slug: "widget", targetRepo: "/tmp/x", defaultBranch: "main", checksSystem: "none", components: [], repoCommands: {}, runtimeContext: {} };
  writeJson(profilePathFor("widget", home), p);
  expect(loadProfileByConvention("widget", home).slug).toBe("widget");
});

test("slugForCwd returns null off-repo and the slug in a repo (injected git)", () => {
  expect(slugForCwd("/nope", () => { throw new Error("not a repo"); })).toBeNull();
  const fakeGit = (args: string[]) => (args[0] === "rev-parse" ? "/repo/acme-widget" : "");
  // injected git returns the (fabricated, nonexistent) toplevel; deriveSlug's REAL `git config`
  // then runs in that missing dir → hardened tryGit catches the spawn ENOENT → null → basename fallback
  expect(slugForCwd("/anything", fakeGit)).toBe("acme-widget");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/config/discover.test.ts`
Expected: FAIL — `src/config/discover.ts` does not exist.

- [ ] **Step 3: Create `src/config/discover.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../dispatch/profile.ts";
import { loadProfile } from "../dispatch/profile.ts";
import { configDir } from "./paths.ts";
import { type RuntimeConfig, RuntimeConfigSchema } from "./runtime-config.ts";
import { type GitRun, deriveSlug, discoverRepoRoot } from "./slug.ts";

/** The repo slug for the cwd, or null when cwd is not a git repo. */
export function slugForCwd(cwd: string = process.cwd(), git?: GitRun): string | null {
  try {
    return deriveSlug(git ? discoverRepoRoot(cwd, git) : discoverRepoRoot(cwd));
  } catch {
    return null;
  }
}

/** The conventional profile path for a slug. */
export function profilePathFor(slug: string, configHome: string = configDir()): string {
  return join(configHome, slug, "profile.json");
}

/** Load the profile from its conventional location; throw a setup-pointing error only when the file
 *  is ABSENT. A present-but-malformed profile propagates its parse/zod error unchanged. */
export function loadProfileByConvention(slug: string, configHome: string = configDir()): Profile {
  const path = profilePathFor(slug, configHome);
  if (!existsSync(path)) {
    throw new Error(`styre run: no profile for '${slug}' at ${path} — run \`styre setup\` first`);
  }
  return loadProfile(path);
}

/** Read+parse a JSON file, {} when absent; a present-but-malformed file throws naming the file. */
function readJsonIfPresent(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`styre: malformed config at ${path}: ${String(err)}`);
  }
}

/** Resolve the runtime config. Explicit `explicitPath` is hermetic (sole source; today's behavior).
 *  Else shallow-merge (per top-level key) the raw global + per-slug JSON, then parse so defaults
 *  fill gaps. The nested `agent` block is replaced wholesale and must be complete when present. */
export function discoverRuntimeConfig(opts: {
  explicitPath?: string;
  slug?: string;
  configHome?: string;
}): RuntimeConfig {
  if (opts.explicitPath && opts.explicitPath.length > 0) {
    return RuntimeConfigSchema.parse(JSON.parse(readFileSync(opts.explicitPath, "utf8")));
  }
  const home = opts.configHome ?? configDir();
  const global = readJsonIfPresent(join(home, "config.json"));
  const perProject = opts.slug ? readJsonIfPresent(join(home, opts.slug, "config.json")) : {};
  return RuntimeConfigSchema.parse({ ...global, ...perProject });
}
```

(Note: `readJsonIfPresent` names the file for JSON-**syntax** errors. A zod-type error surfaces from the single merged `.parse()` as a field-level error, not file-named — an accepted consequence of the raw-merge-then-parse design, since per-file `.parse()` would apply defaults per file and corrupt the merge.)

- [ ] **Step 4: Run to verify pass + gates**

Run: `bun test test/config/discover.test.ts && bun run typecheck && bun run lint`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config/discover.ts test/config/discover.test.ts
git commit -m "feat(config): discover profile + runtime config by convention (XDG)"
```

---

### Task 3: Wire `styre run` (profile optional + `--slug` + config discovery) and sandbox the affected test

**Files:**
- Modify: `src/cli/run.ts`
- Modify: `test/cli/run-inplace-discovery.test.ts` (sandbox `XDG_CONFIG_HOME` — H1 from review)
- Test: `test/cli/run-convention.test.ts` (new)

**Interfaces:**
- Consumes: `slugForCwd`, `loadProfileByConvention`, `discoverRuntimeConfig` (Task 2); `loadProfile` (explicit path).
- Produces: `styre run` resolves profile + runtime config by convention when the flags are omitted; `--profile`/`--config`/`--slug` are overrides.

- [ ] **Step 1: Sandbox the existing test first (prove H1), then add the convention test**

In `test/cli/run-inplace-discovery.test.ts`, in `invokeRun`, sandbox `XDG_CONFIG_HOME` to a fresh empty tmp dir alongside the existing `STYRE_TELEMETRY` guard so the no-`--config` path reads an empty config home instead of the host's:

```ts
async function invokeRun(profilePath: string): Promise<void> {
  const prevTelemetry = process.env.STYRE_TELEMETRY;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.STYRE_TELEMETRY = "0";
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "styre-xdg-empty-")); // no convention files
  try {
    await runCommand.run?.({
      rawArgs: [],
      cmd: runCommand,
      args: { _: [], profile: profilePath, "in-place": true } as unknown as Parameters<
        NonNullable<typeof runCommand.run>
      >[0]["args"],
    });
  } finally {
    if (prevTelemetry === undefined) process.env.STYRE_TELEMETRY = undefined;
    else process.env.STYRE_TELEMETRY = prevTelemetry;
    // Restore XDG with delete, NOT `= undefined`: the string "undefined" has length>0, so
    // configDir() would compute "undefined/styre" and leak it to later tests in the same process.
    if (prevXdg === undefined)
      // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
}
```
(This `delete` + `biome-ignore` is the same pattern `test/cli/setup-inplace-discovery.test.ts:98-99` already uses for its XDG restore.)

Create `test/cli/run-convention.test.ts`:

```ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/cli/run.ts";
import { profilePathFor } from "../../src/config/discover.ts";

function realRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-conv-repo-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  return dir;
}
// A minimal profile whose must-have commands are resolved (assertResolved passes) is overkill here;
// these tests stop BEFORE assertResolved matters by asserting the profile-resolution error/branch.

async function invoke(args: Record<string, unknown>, cwd: string, xdg: string): Promise<unknown> {
  const prev = { t: process.env.STYRE_TELEMETRY, x: process.env.XDG_CONFIG_HOME, c: process.cwd() };
  process.env.STYRE_TELEMETRY = "0";
  process.env.XDG_CONFIG_HOME = xdg;
  process.chdir(cwd);
  try {
    return await runCommand.run?.({ rawArgs: [], cmd: runCommand, args: { _: [], ...args } as never });
  } finally {
    process.env.STYRE_TELEMETRY = prev.t;
    if (prev.x === undefined)
      // biome-ignore lint/performance/noDelete: env must be truly unset, not the string "undefined"
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev.x;
    process.chdir(prev.c);
  }
}

test("run with no --profile and no conventional profile → run-setup error", async () => {
  const repo = realRepo();      // slug = basename(repo)
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  await expect(invoke({}, repo, xdg)).rejects.toThrow(/run `styre setup` first/);
});

test("run with no --profile outside a git repo → cd/pass-profile error", async () => {
  const notRepo = mkdtempSync(join(tmpdir(), "styre-notrepo-"));
  const xdg = mkdtempSync(join(tmpdir(), "styre-xdg-"));
  await expect(invoke({}, notRepo, xdg)).rejects.toThrow(/not a git repo/);
});
```

- [ ] **Step 2: Run to verify the new test fails**

Run: `bun test test/cli/run-convention.test.ts`
Expected: FAIL — today `--profile` is required, so `run()` throws a different/early error (or citty-shaped), not the convention errors.

- [ ] **Step 3: Rewire `src/cli/run.ts`**

Imports: drop `readFileSync` from the `node:fs` import (keep `mkdtempSync`); delete the `import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../config/runtime-config.ts";` line; add:

```ts
import { discoverRuntimeConfig, loadProfileByConvention, slugForCwd } from "../config/discover.ts";
```

Make `--profile` optional and add `--slug` in the `args` block:

```ts
    profile: {
      type: "string",
      description: "Path to the project-profile JSON (default: ~/.config/styre/<slug>/profile.json for the cwd repo)",
    },
    slug: { type: "string", description: "Project slug to locate the profile + per-project config (default: derived from the cwd repo)" },
```
(remove the `required: true` on `profile`.)

Replace the top of `async run({ args })` — the `const profile = loadProfile(args.profile);` line through the `runtimeConfig` ternary (currently ~lines 61-66) — with:

```ts
    let profile: Profile;
    let slug: string;
    if (args.profile && args.profile.length > 0) {
      profile = loadProfile(args.profile);
      slug = args.slug && args.slug.length > 0 ? args.slug : profile.slug;
    } else {
      const derived = args.slug && args.slug.length > 0 ? args.slug : slugForCwd();
      if (!derived) {
        throw new Error(
          "styre run: no --profile given and the current directory is not a git repo — cd into the target repo, or pass --profile / --slug.",
        );
      }
      slug = derived;
      profile = loadProfileByConvention(slug);
    }
    assertResolved(profile);
    const runtimeConfig = discoverRuntimeConfig({ explicitPath: args.config, slug });
```

(Everything below — `createAnalytics(runtimeConfig)`, the in-place block, resume, dispatch — is unchanged. The in-place block's lazy `await import("../dispatch/in-place.ts")` still resolves `discoverRepoRoot` via the Task 1 re-export.)

- [ ] **Step 4: Run the full suite + gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS — `run-convention.test.ts` green; `run-inplace-discovery.test.ts` green under the XDG sandbox; `run-e2e.test.ts` (uses `runTicket` directly, unaffected) green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/run.ts test/cli/run-inplace-discovery.test.ts test/cli/run-convention.test.ts
git commit -m "feat(run): discover profile + config by convention; --profile optional, add --slug"
```

---

### Task 4: Wire `styre setup` (effective slug for config + profile)

Feed the setup credential gate + `resolveAgentRunner` from the discovered runtime config, using one effective slug (`args.slug ?? deriveSlug(repo)`) for both the config lookup and the profile write — so a `--slug` project keeps config + profile in the same `<slug>/` dir.

**Files:**
- Modify: `src/cli/setup.ts`
- Modify: `test/cli/setup-inplace-discovery.test.ts` (sandbox `XDG_CONFIG_HOME` in `invokeSetup` — H3 from review; MANDATORY, not conditional)

**Interfaces:**
- Consumes: `discoverRuntimeConfig` (Task 2), `deriveSlug` (Task 1 leaf), `requiredEnvFor`/`DEFAULT_AGENT_CONFIG`/`resolveAgentRunner` (existing).

- [ ] **Step 1: Rewire `src/cli/setup.ts`**

Imports: drop `readFileSync` from the `node:fs` import (keep `existsSync, mkdirSync, writeFileSync`); change the runtime-config import to `import { DEFAULT_RUNTIME_CONFIG } from "../config/runtime-config.ts";` (drop `RuntimeConfigSchema` — still used by `createAnalytics(DEFAULT_RUNTIME_CONFIG)` at ~line 259, so keep `DEFAULT_RUNTIME_CONFIG`); add:

```ts
import { discoverRuntimeConfig } from "../config/discover.ts";
import { deriveSlug } from "../config/slug.ts";
```

Replace the agentConfig ternary (currently ~lines 226-229) with an effective-slug computation feeding both config discovery and the probe override:

```ts
    const effSlug = args.slug && args.slug.length > 0 ? args.slug : deriveSlug(resolve(repo));
    const runtimeConfig = discoverRuntimeConfig({ explicitPath: args.config, slug: effSlug });
    const agentConfig = runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG;
```

The credential gate (`requiredEnvFor(agentConfig.provider)` …) and `resolveAgentRunner(agentConfig)` below are unchanged. In the `runSetup({ … })` call, change `slug: args.slug` to `slug: effSlug` so the profile is written under the same effective slug used for config discovery.

(`createAnalytics(DEFAULT_RUNTIME_CONFIG)` at ~line 259 is left as-is — setup's analytics knob is out of scope for this task.)

- [ ] **Step 2: Sandbox `XDG_CONFIG_HOME` in the setup wrapper test (H3 — MANDATORY)**

`test/cli/setup-inplace-discovery.test.ts` tests 2 & 3 drive the `setup` wrapper without `--config` and assert `.rejects.toThrow(/ANTHROPIC_API_KEY/)`. After Step 1, setup resolves the provider from the host `~/.config/styre/config.json` — and this feature's own motivating scenario (a global config selecting Codex) makes the gate throw `OPENAI_API_KEY is required for provider 'codex'`, so `/ANTHROPIC_API_KEY/` fails. Make every invocation hermetic by sandboxing XDG inside the shared `invokeSetup` helper (it already sandboxes `ANTHROPIC_API_KEY`; `mkdtempSync`/`tmpdir`/`join` are already imported in this file):

```ts
async function invokeSetup(repo?: string): Promise<void> {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  // biome-ignore lint/performance/noDelete: env var must be truly unset, not the string "undefined"
  delete process.env.ANTHROPIC_API_KEY;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "styre-setup-xdg-empty-")); // no host config
  try {
    await setupCommand.run?.({
      rawArgs: [],
      cmd: setupCommand,
      args: { _: [], repo } as unknown as Parameters<NonNullable<typeof setupCommand.run>>[0]["args"],
    });
  } finally {
    if (prevKey === undefined)
      // biome-ignore lint/performance/noDelete: restoring an unset env var requires delete
      delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevXdg === undefined)
      // biome-ignore lint/performance/noDelete: restoring an unset env var requires delete
      delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
  }
}
```
(Test 1 sets its own XDG for its "nothing written under configDir" assertion; the helper's nested save/restore leaves that intact — test 1 throws `/disposable/` before any config read or write, so nothing lands in either dir.)

- [ ] **Step 3: Run the full suite + gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS — `setup.test.ts` (drives `runSetup` directly, unaffected) and `setup-inplace-discovery.test.ts` green under the XDG sandbox.

- [ ] **Step 4: Commit**

```bash
git add src/cli/setup.ts test/cli/setup-inplace-discovery.test.ts
git commit -m "feat(setup): resolve agent/provider config by convention (effective slug)"
```

---

### Task 5: Docs — README "Running by convention" + build-operations pointer

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/build-operations.md`

- [ ] **Step 1: Add a README section**

Add a "Running by convention" subsection documenting the XDG layout and zero-flag flow:

```markdown
### Running by convention

`styre setup` writes the project profile to `~/.config/styre/<slug>/profile.json`. After that,
`styre run` needs no path flags — from inside the repo:

    cd my-repo && styre run ENG-123

It derives the `<slug>` from the repo's `origin` remote (or dir name), loads that profile, and
resolves the runtime config by merging:

- `~/.config/styre/config.json` — global (applies to every project)
- `~/.config/styre/<slug>/config.json` — per-project override

Per-project wins per setting; the `agent` block (provider + models) must be written complete.
Example — use Codex everywhere by writing the full block once in the global file:

    { "agent": { "provider": "codex", "command": "codex",
                 "models": { "deep": "…", "standard": "…", "cheap": "…" } } }

Explicit `--profile` / `--config` override discovery and are hermetic (host config is ignored),
for CI/fleet callers. A custom `styre setup --slug <name>` stores under that slug — pass
`--slug <name>` (or `--profile`) to `styre run` for such a project.
```

- [ ] **Step 2: Add a build-operations pointer**

In `docs/architecture/build-operations.md` §4 (the config-tier table / precedence note), add a one-line pointer that the workspace-config loader now exists:

```markdown
> **`[IMPLEMENTED 2026-07-07]`** The workspace-config loader is wired: `styre run`/`setup` discover
> `~/.config/styre/config.json` (global) + `~/.config/styre/<slug>/config.json` (per-project),
> shallow-merged under an explicit `--config`. Profile auto-discovery by slug is likewise live for
> `styre run`. See `docs/brainstorms/2026-07-07-config-profile-by-convention-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/architecture/build-operations.md
git commit -m "docs: document run/config by convention (XDG discovery)"
```

---

## Self-Review notes (spec coverage)

- DEC-CV-1 layout → Tasks 2/3/4 (paths via `configDir()`/`configHome`). DEC-CV-2 profile-by-convention (run only) → Task 3. DEC-CV-3 shallow merge + agent all-or-nothing → Task 2 (`discoverRuntimeConfig` + tests). DEC-CV-4 hermetic explicit flags → Task 2 (explicit-path branch) + Tasks 3/4 wiring. DEC-CV-5 shared slug + `--slug` reconciliation → Task 1 (`deriveSlug` leaf) + Task 3 (`run --slug`) + Task 4 (effective slug for config + profile). DEC-CV-6 `config/` leaf → Task 1.
- H1 (test goes non-hermetic) → Task 3 Step 1 (XDG sandbox) + Task 4 Step 2 (verify/guard setup test). H2/M1 (`setup --slug`) → Tasks 3+4. M2 (eager heavy import) → Task 1 leaf. M3 (partial agent) → Task 2 test. L2 (ENOENT vs malformed) → Task 2 `loadProfileByConvention`.
- No schema change; explicit-flag callers byte-preserved (hermetic branches).

## Independent review (2026-07-07)

A fresh, code-grounded reviewer verified every task against the source. Verdict: architecture sound,
wiring almost entirely correct; not executable as-first-written due to small gate-level defects, all
now folded in:

- **Critical (typecheck):** removing `deriveSlug` from `probe.ts` orphaned `basename`
  (`noUnusedLocals` → TS6133). Task 1 now drops `basename` from the `node:path` import.
- **Critical (test):** the `discover.test.ts` `slugForCwd` injected-git case failed because
  `Bun.spawnSync` THROWS (not `{success:false}`) on a fabricated nonexistent cwd, propagating through
  the unguarded `tryGit`. Fixed at the source: `tryGit` now wraps `Bun.spawnSync` in try/catch
  (honoring its "null on any failure" contract), which also hardens the real `slugForCwd`.
- **High (existing tests non-hermetic):** `setup-inplace-discovery.test.ts` tests 2 & 3 reach the
  credential gate without `--config` and would read host `~/.config` — breaking exactly under this
  feature's Codex-global scenario. Task 4 now MANDATORILY sandboxes `XDG_CONFIG_HOME` in `invokeSetup`.
- **Medium (env leak):** restoring `XDG_CONFIG_HOME = undefined` sets the string `"undefined"`, which
  `configDir()` turns into `"undefined/styre"`. Both new test helpers now restore via guarded
  `delete` + `biome-ignore lint/performance/noDelete` (the repo's existing pattern).
- **Low (stale comment):** Task 1 now trims the `github.ts` prose describing the moved
  `parseGitHubRemote`.

Cleared non-findings: no import cycle (`discover.ts → dispatch/profile.ts`, which imports only
`node:fs` + `zod`), DEC-CV-6's "no new heavy startup deps" holds, explicit-flag hermetic branches are
byte-preserving, and every DEC-CV-1..6 maps to a task.
