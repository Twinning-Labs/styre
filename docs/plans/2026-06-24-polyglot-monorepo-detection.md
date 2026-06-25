# Polyglot-Monorepo Detection & Setup Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `styre setup` produce the `components[]` profile that Plan 1's runtime consumes — via deterministic scan (anchored on manifests + workspace membership) → read-only agent refinement of the fuzzy fields → an interactive TTY command-resolution ladder, command-existence probing, and `scriptRunner` warnings.

**Architecture:** `probeProfile` gains `detectComponents()` (the deterministic anchor: one component per manifest/workspace, with candidate commands and paths). A new read-only `setup:discover` agent refines path boundaries, command→stack assignment, `repoCommands`, and `kind` labels, reconciled against the scan (workspace membership is authoritative — the agent cannot override it). Each must-have command (`build`/`test`/`check`) then resolves through a TTY ladder: detected → ask → confirmed-`unavailable` + warning. `styre run` consumes the frozen profile; an unresolved must-have at run time is a hard error.

**Tech Stack:** TypeScript (Bun), zod, `bun:test`, biome. TTY via Bun's global `prompt()` + `process.stdin.isTTY`. Manifest parsing: `JSON.parse` (package.json), regex over `Cargo.toml` `[workspace].members`.

**Depends on:** Plan 1 (`2026-06-24-polyglot-monorepo-runtime.md`) — the `Component`/`Profile` schema and `components.ts` helpers (`commandFor`, `isScriptRunner`, etc.). Do Plan 1 first.

## Global Constraints

- **Deterministic scan is authoritative on structural facts** (manifest locations, workspace membership). The agent **refines** the fuzzy fields and may NOT override workspace membership.
- **Discovery agent is read-only** (`["Read","Grep","Glob"]`), mirroring `setup:enrich`. No agent at run time.
- **Command-existence probing catches typos/missing tools only** — not correctness, not safety. The TTY operator-confirm of the command list is the security control (commands run via `sh -c` at verify and seed the implement Bash allowlist).
- **Every persisted must-have command is a string or `{ unavailable: true }`** — never blank. The unresolved state lives only during the TTY conversation.
- **`styre run` is non-interactive:** an unresolved must-have in a loaded profile is a hard error, never a guess. TTY prompting is a `styre setup`-only capability with a non-TTY fallback that errors rather than proceeding.
- **Formatting/tests:** biome (2-space, width 100); `bun:test`; run `bun run typecheck && bun run lint && bun test` before each commit.

---

## File Structure

- `src/setup/detect-components.ts` — **create**: deterministic manifest/workspace scan → `Component[]` skeleton + candidate `repoCommands`.
- `src/setup/probe.ts` — **modify**: emit `components` + `repoCommands` (replace the Plan-1 stopgap).
- `prompts/setup-discover.md` — **create**: the read-only discovery prompt.
- `src/setup/discover-schema.ts` — **create**: `DiscoverSchema` (agent output) + the reconciliation merge.
- `src/setup/discover.ts` — **create**: `discoverComponents()` orchestrator (mirrors `enrich.ts`) + command-existence probe.
- `src/dispatch/tool-allowlists.ts` — **modify**: add `"setup:discover"` (read-only).
- `src/setup/resolve-commands.ts` — **create**: the TTY command-resolution ladder + `scriptRunner` warnings.
- `src/cli/setup.ts` — **modify**: wire discover + resolve into `runSetup`; non-TTY fallback.
- Tests under `test/setup/`.

---

## Task 7: Deterministic component scan

**Files:**
- Create: `src/setup/detect-components.ts`
- Modify: `src/setup/probe.ts:30-43`
- Test: `test/setup/detect-components.test.ts`

**Interfaces:**
- Consumes: `Component` (Plan 1).
- Produces: `detectComponents(repoDir): { components: Component[]; repoCommands: Record<string,string> }`.

- [ ] **Step 1: Write failing test (breev-shaped + Cargo-workspace-shaped fixtures)**

Create `test/setup/detect-components.test.ts`:
```typescript
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectComponents } from "../../src/setup/detect-components.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-dc-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

test("tauri app → one frontend (root package.json) + one rust (src-tauri) component", () => {
  const root = fixture({
    "package.json": JSON.stringify({ scripts: { build: "vite build", check: "svelte-check" } }),
    "svelte.config.js": "export default {}",
    "src-tauri/Cargo.toml": '[package]\nname="app"\n',
  });
  const { components } = detectComponents(root);
  const names = components.map((c) => c.kind).sort();
  expect(names).toContain("rust");
  expect(components.some((c) => c.paths.some((p) => p.startsWith("src-tauri")))).toBe(true);
});

test("cargo workspace collapses members into ONE rust component", () => {
  const root = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["src-tauri", "crates/a", "crates/b"]\n',
    "src-tauri/Cargo.toml": '[package]\nname="app"\n',
    "crates/a/Cargo.toml": '[package]\nname="a"\n',
    "crates/b/Cargo.toml": '[package]\nname="b"\n',
  });
  const { components } = detectComponents(root);
  const rust = components.filter((c) => c.kind === "rust");
  expect(rust).toHaveLength(1);
  expect(rust[0].paths).toEqual(expect.arrayContaining(["src-tauri/**", "crates/**"]));
});
```

- [ ] **Step 2: Run, expect failure** — `bun test test/setup/detect-components.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/setup/detect-components.ts`**

```typescript
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Component } from "../dispatch/profile.ts";

const SKIP = new Set(["node_modules", "target", ".git", "dist", "build", ".svelte-kit"]);

/** Bounded-depth walk collecting manifest paths (relative to repoDir). */
function findManifests(repoDir: string, name: string, maxDepth = 3): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const abs = join(dir, entry);
      const r = rel === "" ? entry : `${rel}/${entry}`;
      if (entry === name) found.push(r);
      else if (statSync(abs).isDirectory()) walk(abs, r, depth + 1);
    }
  };
  walk(repoDir, "", 0);
  return found;
}

/** Parse `members = [ "a", "b" ]` from a Cargo [workspace] manifest (best-effort). */
function cargoWorkspaceMembers(cargoTomlAbs: string): string[] | null {
  const text = readFileSync(cargoTomlAbs, "utf8");
  if (!/\[workspace\]/.test(text)) return null;
  const m = text.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** A glob for a member that may itself contain globs (e.g. "crates/*"). */
function memberGlob(member: string): string {
  return member.includes("*") ? `${member.replace(/\*+$/, "")}**` : `${member}/**`;
}

/** Deterministic component skeleton: anchors the agent refine + the command ladder. */
export function detectComponents(repoDir: string): {
  components: Component[];
  repoCommands: Record<string, string>;
} {
  const components: Component[] = [];

  // --- Rust: collapse a workspace into one component; else one per standalone Cargo.toml.
  const cargoRoot = join(repoDir, "Cargo.toml");
  const workspaceMembers = existsSync(cargoRoot) ? cargoWorkspaceMembers(cargoRoot) : null;
  if (workspaceMembers) {
    const paths = new Set<string>(["Cargo.toml", "Cargo.lock"]);
    for (const mb of workspaceMembers) paths.add(memberGlob(mb));
    components.push({
      name: "rust-core", kind: "rust", paths: [...paths],
      commands: { build: "cargo build --workspace", test: "cargo test --workspace" },
    });
  } else {
    for (const rel of findManifests(repoDir, "Cargo.toml")) {
      const dir = rel.replace(/Cargo\.toml$/, "").replace(/\/$/, "");
      components.push({
        name: dir === "" ? "rust" : dir.replace(/\//g, "-"),
        kind: "rust", paths: [dir === "" ? "**" : `${dir}/**`],
        commands: { build: "cargo build", test: "cargo test" },
      });
    }
  }

  // --- Node/JS: one component per package.json (skip workspace-member packages already covered).
  for (const rel of findManifests(repoDir, "package.json")) {
    const dir = rel.replace(/package\.json$/, "").replace(/\/$/, "");
    const pkg = JSON.parse(readFileSync(join(repoDir, rel), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const commands: Component["commands"] = {};
    if (scripts.build) commands.build = `npm run build`;
    if (scripts.test) commands.test = `npm run test`;
    if (scripts.check) commands.check = `npm run check`;
    const isRoot = dir === "";
    const fe = existsSync(join(repoDir, "svelte.config.js")) || existsSync(join(repoDir, "vite.config.js"));
    components.push({
      name: isRoot ? "frontend" : dir.replace(/\//g, "-"),
      kind: isRoot && fe ? "sveltekit" : "node",
      // Co-located frontend: root package.json owns src/static, NOT a sibling rust src-tauri.
      paths: isRoot ? ["src/**", "static/**", "package.json"] : [`${dir}/**`],
      commands,
    });
  }

  return { components, repoCommands: {} };
}
```
> Note: paths/kinds/command-assignment here are a deterministic *first draft*; the agent (Task 8) refines them (e.g. the co-located frontend boundary, `lint:rust`-in-package.json). The scan is authoritative only on *which manifests exist and which are workspace members*.

- [ ] **Step 4: Run, expect pass** — `bun test test/setup/detect-components.test.ts` → PASS.

- [ ] **Step 5: Wire into `probe.ts` (replace the Plan-1 stopgap)**

In `src/setup/probe.ts`, replace `commands: detectCommands(targetRepo)` (and the stopgap `components: []`) with:
```typescript
  const { components, repoCommands } = detectComponents(targetRepo);
```
and put `components, repoCommands,` into the returned profile object (drop the old `commands` field entirely). Import `detectComponents`. Remove the now-unused `detectCommands` import if nothing else uses it (leave `detect.ts` itself in place; `detectChecksSystem`/`detectPackageManager` stay).

- [ ] **Step 6: Full suite** — `bun run typecheck && bun run lint && bun test` → PASS (update `test/setup/probe.test.ts` to assert `components`/`repoCommands` instead of `commands`).

- [ ] **Step 7: Commit**

```bash
git add src/setup/detect-components.ts src/setup/probe.ts test/setup/detect-components.test.ts test/setup/probe.test.ts
git commit -m "feat(setup): deterministic component scan (manifests + cargo workspace collapse)"
```

---

## Task 8: Agent refine (`setup:discover`) + reconciliation merge + command probe

**Files:**
- Create: `prompts/setup-discover.md`, `src/setup/discover-schema.ts`, `src/setup/discover.ts`
- Modify: `src/dispatch/tool-allowlists.ts:8-18` (add `"setup:discover"`)
- Test: `test/setup/discover-schema.test.ts` (merge + probe), `test/setup/discover.test.ts` (orchestrator with `FakeAgentRunner`)

**Interfaces:**
- Consumes: `Component` (Plan 1); `detectComponents` (Task 7); `extractSidecar` (sidecar.ts); `allowlistFor`; `modelForTier`; `AgentRunner`.
- Produces: `DiscoverSchema`; `mergeComponents(scan, proposed): Component[]`; `probeCommandExists(repoDir, cmd): boolean`; `discoverComponents(repoDir, scan, deps): Promise<{components, repoCommands}>`.

- [ ] **Step 1: Write failing merge + probe tests**

Create `test/setup/discover-schema.test.ts`:
```typescript
import { expect, test } from "bun:test";
import { mergeComponents, probeCommandExists } from "../../src/setup/discover-schema.ts";
import type { Component } from "../../src/dispatch/profile.ts";

test("mergeComponents keeps scan's workspace paths but adopts agent's refined boundaries/commands", () => {
  const scan: Component[] = [
    { name: "rust-core", kind: "rust", paths: ["src-tauri/**", "crates/**"], commands: { test: "cargo test --workspace" } },
    { name: "frontend", kind: "node", paths: ["src/**", "static/**", "package.json"], commands: { build: "npm run build" } },
  ];
  const proposed: Component[] = [
    { name: "rust-core", kind: "rust", paths: ["src-tauri/**", "crates/**"], commands: { test: "cargo test --workspace", check: "cargo clippy --workspace" } },
    { name: "frontend", kind: "sveltekit", paths: ["src/**", "static/**", "package.json", "vite.config.js"], commands: { build: "vite build", check: "svelte-check" } },
  ];
  const merged = mergeComponents(scan, proposed);
  const fe = merged.find((c) => c.name === "frontend")!;
  expect(fe.kind).toBe("sveltekit");                       // agent refined the label
  expect(fe.commands.check).toBe("svelte-check");          // agent added a command
  const rust = merged.find((c) => c.name === "rust-core")!;
  expect(rust.paths).toEqual(expect.arrayContaining(["src-tauri/**", "crates/**"])); // anchor preserved
});

test("probeCommandExists is false for a missing binary", () => {
  expect(probeCommandExists(process.cwd(), "definitely-not-a-real-binary-xyz --help")).toBe(false);
  expect(probeCommandExists(process.cwd(), "git status")).toBe(true);
});
```

- [ ] **Step 2: Run, expect failure** — FAIL (module missing).

- [ ] **Step 3: Implement `src/setup/discover-schema.ts`**

```typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Component } from "../dispatch/profile.ts";

/** What the read-only discovery agent proposes. Refines the deterministic skeleton. */
export const DiscoverSchema = z.object({
  components: z.array(
    z.object({
      name: z.string().min(1),
      kind: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
      commands: z.record(z.string(), z.string()).default({}),
    }),
  ),
  repoCommands: z.record(z.string(), z.string()).default({}),
});
export type Discovery = z.infer<typeof DiscoverSchema>;

/** Reconcile agent proposal against the deterministic scan. The scan is authoritative on which
 *  components exist (matched by name); the agent refines kind, paths, and commands of those it
 *  recognizes. Agent-only components (not in the scan) are dropped — the scan anchors existence;
 *  the agent does not invent stacks. A scan component the agent didn't mention survives as-is. */
export function mergeComponents(scan: Component[], proposed: Component[]): Component[] {
  const byName = new Map(proposed.map((p) => [p.name, p]));
  return scan.map((s) => {
    const p = byName.get(s.name);
    if (!p) return s;
    // Agent may refine paths but cannot widen a component via an UNANCHORED glob (one starting with
    // `*`/`**` — e.g. `**`, `*`, `**/*.ts`, `*/**` — which matches broadly across the tree and would
    // run the component's commands on every diff + widen the implement Bash scope). Keep only globs
    // anchored to a literal first path segment. The scan's workspace anchors are always preserved.
    const agentPaths = p.paths.filter((g) => !/^\*/.test(g.trim()));
    return {
      name: s.name,
      kind: p.kind || s.kind,
      paths: [...new Set([...s.paths, ...agentPaths])],
      commands: { ...s.commands, ...p.commands },
      ...(s.testFilePattern ? { testFilePattern: s.testFilePattern } : {}),
    };
  });
}

/** True if the command's program resolves (typo/missing-tool probe only — NOT correctness, NOT
 *  safety). For an `npm run X`, checks the script exists in the cwd package.json; otherwise checks
 *  the binary on PATH. (`readFileSync`/`join` imported at the top of the file.) */
export function probeCommandExists(repoDir: string, command: string): boolean {
  const trimmed = command.trim();
  const npmRun = trimmed.match(/^npm run ([\w:-]+)/);
  if (npmRun) {
    try {
      // NOTE: Bun.file(...).text() is ASYNC (empirically confirmed) — MUST use sync readFileSync here.
      const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8"));
      return Boolean(pkg.scripts?.[npmRun[1]]);
    } catch {
      return false;
    }
  }
  const bin = trimmed.split(/\s+/)[0];
  return Bun.spawnSync(["sh", "-c", `command -v ${bin}`], { cwd: repoDir }).success;
}
```
> The existence probe reduces the typo/missing-tool failure mode only. It does **not** validate that a command is correct or safe — a plausible-but-wrong or malicious string passes. The security control is the operator sign-off in Task 9 (which now displays the FULL command list, including agent-supplied ones).

- [ ] **Step 4: Run, expect pass** — `bun test test/setup/discover-schema.test.ts` → PASS.

- [ ] **Step 5: Add the prompt + allowlist + orchestrator**

Create `prompts/setup-discover.md`:
```markdown
You are mapping the build topology of the repository at the project root for the styre setup probe.
A deterministic scan has produced a draft component list (below). Read the repo (read-only) and
REFINE it — do not invent components the scan did not find.

Draft components (JSON): {{draft}}

For each component, correct:
- **paths**: the glob set that truly belongs to this stack. Critical for co-located stacks — e.g. a
  Tauri app's frontend lives at the repo root but owns `src/**`/`static/**`, NOT the sibling
  `src-tauri/**` Rust crate. Include build-affecting root files (root manifests, lockfiles, shared
  tsconfig) in the component they affect.
- **kind**: a precise free-text stack label (e.g. `sveltekit`, `rust`, `node`).
- **commands**: map check-types (`build`/`test`/`check`/`lint`) to the real command, reading scripts
  wherever they live (e.g. a `lint:rust` script in package.json belongs to the Rust component).
Also propose **repoCommands**: commands that span/own no single component (e.g. an end-to-end suite).

Emit exactly one fenced block:

```styre-setup-discover
{ "components": [ { "name": "...", "kind": "...", "paths": ["..."], "commands": { "test": "..." } } ],
  "repoCommands": { "integration": "..." } }
```
```
In `src/dispatch/tool-allowlists.ts`, add to `ALLOWLISTS`:
```typescript
  "setup:discover": [...READ_ONLY],
```
Create `src/setup/discover.ts` (mirror `enrich.ts` structure):
```typescript
import discoverTemplate from "../../prompts/setup-discover.md" with { type: "text" };
import type { AgentRunner } from "../agent/runner.ts";
import { type AgentConfig, modelForTier } from "../config/agent-config.ts";
import type { Component } from "../dispatch/profile.ts";
import { allowlistFor } from "../dispatch/tool-allowlists.ts";
import { renderPrompt } from "../dispatch/render-prompt.ts";
import { extractSidecar } from "../dispatch/sidecar.ts";
import { DiscoverSchema, mergeComponents, probeCommandExists } from "./discover-schema.ts";

const DISCOVER_TIMEOUT_MS = 300_000;

/** Refine the deterministic component skeleton with a read-only agent, reconcile against the scan,
 *  and drop commands that fail the existence probe. Falls back to the scan on agent failure. */
export async function discoverComponents(
  repoDir: string,
  scan: { components: Component[]; repoCommands: Record<string, string> },
  deps: { runner: AgentRunner; agentConfig: AgentConfig },
): Promise<{ components: Component[]; repoCommands: Record<string, string> }> {
  const rendered = renderPrompt(discoverTemplate, { draft: JSON.stringify(scan.components) });
  if (!rendered.ok) return scan;
  const result = await deps.runner.run({
    prompt: rendered.prompt,
    model: modelForTier(deps.agentConfig, "standard"),
    allowedTools: allowlistFor("setup:discover"),
    cwd: repoDir,
    timeoutMs: DISCOVER_TIMEOUT_MS,
  });
  if (!result.completed || result.timedOut) return scan;
  const parsed = extractSidecar(result.stdout, DiscoverSchema, { fence: "styre-setup-discover" });
  if (!parsed.ok) return scan;

  const merged = mergeComponents(scan.components, parsed.value.components as Component[]);
  // Drop probe-failing commands (typo/missing tool) — they become absent, to be resolved by the ladder.
  const components = merged.map((c) => ({
    ...c,
    commands: Object.fromEntries(
      Object.entries(c.commands).filter(([, v]) =>
        typeof v === "string" ? probeCommandExists(repoDir, v) : true,
      ),
    ),
  }));
  return { components, repoCommands: parsed.value.repoCommands };
}
```
> `allowlistFor("setup:discover")` is called with no `opts` — confirm `allowlistFor`'s signature allows that (it does: `opts?` is optional).

- [ ] **Step 6: Write + run the orchestrator test**

Create `test/setup/discover.test.ts` using a `FakeAgentRunner` that returns a fenced `styre-setup-discover` block refining a scan; assert the merged result adopts the agent's `kind`/commands and keeps scan paths; assert a fabricated non-existent command is dropped. Also assert that a FakeAgentRunner returning `{completed:false}` yields the scan unchanged (fallback).
Run: `bun test test/setup/discover.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add prompts/setup-discover.md src/setup/discover-schema.ts src/setup/discover.ts src/dispatch/tool-allowlists.ts test/setup/discover-schema.test.ts test/setup/discover.test.ts
git commit -m "feat(setup): read-only component-discovery agent + reconciliation merge + command probe"
```

---

## Task 9: TTY command-resolution ladder + scriptRunner warnings + run-time hard-fail

**Files:**
- Create: `src/setup/resolve-commands.ts`
- Modify: `src/cli/setup.ts` (wire discover + resolve into `runSetup`)
- Test: `test/setup/resolve-commands.test.ts`

**Interfaces:**
- Consumes: `Component`, `commandFor`, `isUnavailable`, `isScriptRunner` (Plan 1).
- Produces: `resolveCommands(components, opts): { components: Component[]; warnings: string[] }` where `opts = { interactive: boolean; ask: (q: string) => string | null }`. Must-have classes `["build","test","check"]`. For each missing must-have: `ask` → a non-empty answer becomes the command; an empty/"none" answer (or non-interactive) becomes `{ unavailable: true }`. Emits a warning for each `unavailable` and each `isScriptRunner` command.

- [ ] **Step 1: Write failing test (injectable `ask`, no real TTY)**

Create `test/setup/resolve-commands.test.ts`:
```typescript
import { expect, test } from "bun:test";
import { resolveCommands } from "../../src/setup/resolve-commands.ts";
import type { Component } from "../../src/dispatch/profile.ts";

const base = (): Component[] => [
  { name: "rust", kind: "rust", paths: ["src-tauri/**"], commands: { build: "cargo build", test: "cargo test" } },
  { name: "fe", kind: "sveltekit", paths: ["src/**"], commands: { build: "vite build" } },
];

test("operator supplies a missing test command", () => {
  const answers = ["bun test"];
  const { components } = resolveCommands(base(), {
    interactive: true,
    ask: () => answers.shift() ?? null,
  });
  const fe = components.find((c) => c.name === "fe")!;
  expect(fe.commands.test).toBe("bun test");
});

test("operator declines → unavailable + warning; non-interactive missing also unavailable", () => {
  const { components, warnings } = resolveCommands(base(), { interactive: true, ask: () => "" });
  const fe = components.find((c) => c.name === "fe")!;
  expect(fe.commands.test).toEqual({ unavailable: true });
  expect(warnings.some((w) => /fe.*test/i.test(w))).toBe(true);
});

test("script-runner commands trigger a warning", () => {
  const comps: Component[] = [
    { name: "sidecar", kind: "node", paths: ["sidecar/**"], commands: { build: "bash build.sh", test: { unavailable: true }, check: { unavailable: true } } },
  ];
  const { warnings } = resolveCommands(comps, { interactive: false, ask: () => null });
  expect(warnings.some((w) => /bash build\.sh/.test(w))).toBe(true);
});
```

- [ ] **Step 2: Run, expect failure** — FAIL (module missing).

- [ ] **Step 3: Implement `src/setup/resolve-commands.ts`**

```typescript
import { type Component, type CommandValue } from "../dispatch/profile.ts";
import { commandFor, isScriptRunner, isUnavailable } from "../dispatch/components.ts";

const MUST_HAVE = ["build", "test", "check"] as const;

export interface ResolveOpts {
  interactive: boolean;
  /** Returns the operator's line, or null for EOF / non-interactive. */
  ask: (question: string) => string | null;
}

/** Resolve every component's must-have commands to a string or `{ unavailable: true }`, prompting
 *  the operator (interactive) for missing ones. Emits warnings for unavailable commands and for
 *  script-runner commands (which cannot be tightly Bash-scoped). */
export function resolveCommands(
  components: Component[],
  opts: ResolveOpts,
): { components: Component[]; warnings: string[] } {
  const warnings: string[] = [];
  const out = components.map((c) => {
    const commands: Record<string, CommandValue> = { ...c.commands };
    for (const k of MUST_HAVE) {
      if (commandFor(c, k) !== undefined) continue; // already a real command
      if (isUnavailable(c, k)) continue; // already confirmed-none
      const answer = opts.interactive
        ? opts.ask(`${c.name} (${c.kind}) has no ${k} command — supply one, or leave blank for none:`)
        : null;
      if (answer && answer.trim() !== "" && answer.trim().toLowerCase() !== "none") {
        commands[k] = answer.trim();
      } else {
        commands[k] = { unavailable: true };
        warnings.push(`⚠ ${c.name}: no ${k} command — styre cannot ground-truth-${k} this stack.`);
      }
    }
    for (const [k, v] of Object.entries(commands)) {
      if (typeof v === "string" && isScriptRunner(v)) {
        warnings.push(`⚠ ${c.name}.${k} = "${v}" is a shell script — its Bash scope cannot be tightened.`);
      }
    }
    return { ...c, commands };
  });
  return { components: out, warnings };
}
```

- [ ] **Step 4: Run, expect pass** — `bun test test/setup/resolve-commands.test.ts` → PASS.

- [ ] **Step 5: Wire discover + resolve into `runSetup` (`src/cli/setup.ts`)**

After `probeProfile` and the runtime-context enrich (existing), and **before** the profile is written to disk (`setup.ts:73`), add (note the local repo-path variable in `runSetup` is `repoDir`, not `targetRepo`):
```typescript
  const discovered = await discoverComponents(repoDir, {
    components: scanProfile.components, repoCommands: scanProfile.repoCommands,
  }, { runner: args.deps.runner, agentConfig: DEFAULT_AGENT_CONFIG });
  // ^ runSetup's param is `args.deps` (see the existing enrich call at setup.ts:57), not a local `deps`.

  const interactive = Boolean(process.stdin.isTTY);
  const { components, warnings } = resolveCommands(discovered.components, {
    interactive,
    ask: (q) => (interactive ? (globalThis.prompt(q) ?? null) : null),
  });
  for (const w of warnings) console.warn(w);

  // SECURITY-BEARING CONFIRM: every command (incl. agent-supplied ones) runs via `sh -c` at verify
  // and seeds the implement Bash allowlist. Show the FULL final command list and require explicit
  // operator sign-off — not just prompting for the ones that were missing.
  if (interactive) {
    console.log("\nResolved components (commands run with repo write + network; paths drive verify routing):");
    for (const c of components) {
      console.log(`  ${c.name} [${c.kind}]  paths: ${c.paths.join(", ")}`);
      for (const [k, v] of Object.entries(c.commands)) {
        console.log(`    ${k}: ${typeof v === "string" ? v : "(none)"}`);
      }
    }
    for (const [name, cmd] of Object.entries(discovered.repoCommands)) console.log(`  repo.${name}: ${cmd}`);
    const ok = globalThis.prompt("Approve these components (commands + paths)? [y/N]");
    if (ok?.trim().toLowerCase() !== "y") {
      throw new Error("setup aborted: operator did not approve the command list");
    }
  }
```
Set the final profile's `components` to `components` and `repoCommands` to `discovered.repoCommands`. Imports: `discoverComponents` from `../setup/discover.ts`, `resolveCommands` from `../setup/resolve-commands.ts`. (Non-TTY setup proceeds without the prompt but emits the warnings; the run-time guard below still blocks any unresolved must-have.)

Add a **run-time hard-fail** so headless `styre run` never proceeds with an unresolved must-have. In `src/cli/run.ts` (where the profile is loaded via `loadProfile`), after load, assert:
```typescript
for (const c of profile.components) {
  for (const k of ["build", "test", "check"] as const) {
    const v = c.commands[k];
    if (v === undefined) {
      throw new Error(`profile component '${c.name}' has an unresolved '${k}' command — re-run \`styre setup\`.`);
    }
  }
}
```
> A must-have is "resolved" iff it is a string OR `{ unavailable: true }`. `undefined` (absent key) is the unresolved state and is a hard error at run time.

- [ ] **Step 6: Test the non-TTY + run-time-guard behavior**

Add to `test/setup/resolve-commands.test.ts` (or a `test/cli/run-guard.test.ts`): a non-interactive `resolveCommands` over a component missing `test` yields `{ unavailable: true }` (already covered) — and a separate unit test of the run-time guard: a profile component with `commands: {}` (no `test`) throws the unresolved error; one with `{ test: { unavailable: true } }` does not. Extract the guard into a small exported helper `assertResolved(profile)` if that makes it testable without invoking the full CLI.
Run: `bun test test/setup/ test/cli/` → PASS.

- [ ] **Step 7: Full suite + lint** — `bun run typecheck && bun run lint && bun test` → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/setup/resolve-commands.ts src/cli/setup.ts src/cli/run.ts test/setup/resolve-commands.test.ts
git commit -m "feat(setup): interactive command-resolution ladder + scriptRunner warnings + run-time guard"
```

---

## Self-Review

**Spec coverage (design doc §4/§5):** §5 deterministic scan + workspace collapse → Task 7. §5 agent refine + reconciliation + existence-probe + security-bearing confirm → Task 8 + Task 9 (operator confirm is the TTY ladder). §4 command-resolution ladder (detect→ask→unavailable+warn) → Task 9. §4 headless hard-fail on unresolved must-have → Task 9 Step 5 (run-time guard). §3 build-affecting root files in `paths` (decision B) → Task 7 (root files in component paths) + Task 8 prompt (agent told to include them). §7 scriptRunner warning (decision #3) → Task 9.

**Placeholder scan:** Tasks 8 Step 6 and 9 Step 6 describe tests in prose with exact assertions rather than full code — acceptable (the orchestrator/CLI-wiring tests depend on the codebase's `FakeAgentRunner` fence wiring shown in Task 8 Step 5 and the helper extraction noted inline). Expand to full code at execution. No "TODO"/"handle edge cases" placeholders.

**Type consistency:** `detectComponents` return shape (`{components, repoCommands}`) is consumed identically by `probe.ts` (Task 7) and `discoverComponents` (Task 8). `mergeComponents`/`probeCommandExists`/`DiscoverSchema` defined in Task 8, used in `discover.ts`. `resolveCommands` signature defined in Task 9 and matches its test. `commandFor`/`isUnavailable`/`isScriptRunner` are Plan 1 exports.

**Dependency:** Task 7 replaces the Plan-1 N=1 `probe.ts` bridge with real multi-component detection; do Plan 1 first. Tasks 7→8→9 are strictly ordered (8 consumes 7's output; 9 consumes 8's).

---

## Revision log (post plan review — 4 independent reviewers)

- **`probeCommandExists` async bug fixed (Task 8 Step 3):** `Bun.file().text()` is async (empirically confirmed) → now uses sync `readFileSync` mandatorily, not "if awkward."
- **Agent path-injection capped (Task 8 `mergeComponents`):** the agent can refine paths but a catch-all (`**`/`*`/`**/*`) is dropped — it can't widen a component to match every diff (which would run its commands on everything + widen the implement Bash scope). Scan workspace anchors are always preserved.
- **Security-bearing operator confirm (Task 9 Step 5):** setup now displays the FULL final command list — including agent-supplied commands for already-populated slots — and requires explicit `[y/N]` sign-off, closing the gap where agent-injected commands were never confirmed (they only get prompted when *missing*). The probe is explicitly noted as typo/missing-tool only, not a safety control.
- **Wiring fix (Task 9 Step 5):** the local repo-path variable is `repoDir`, not `targetRepo`; the discover/resolve block runs before the profile write (`setup.ts:73`).
- **Ordering note:** `allowlistFor("setup:discover")` throws if the key isn't registered; Task 8 Step 5 adds the `setup:discover` ALLOWLISTS entry, which must land with (before) the `discover.ts` that calls it.
- (Coherence: `repoCommands` from the agent *replace* the scan's wholesale — intended, since they're free-text and unanchored; documented here rather than merged.)

### Round 3 (second plan review)
- **Glob filter hardened (Task 8 `mergeComponents`):** the exact-string denylist (`**`/`*`/`**/*`) was bypassable by `**/*.ts`, `*/**`, etc. Now rejects any **unanchored** agent glob (one starting with `*`/`**`), keeping only literal-anchored paths. (Adversarial N1.)
- **Paths shown in the security confirm (Task 9 Step 5):** the `[y/N]` sign-off now lists each component's `paths` *and* commands, so a widened-`paths` injection is visible to the operator, not just commands. (Adversarial N1.)
- **Imports moved to top of `discover-schema.ts`** (cosmetic; mid-file was valid + lint-clean, but conventional placement removes the dispute). (Adversarial N5 / Feasibility #3.)
- **Wiring typo fixed (Task 9 Step 5):** `args.deps.runner`, not `deps.runner` (runSetup's param is `args.deps`). (Feasibility #4.)
- **Known footgun (accepted, per operator):** a non-must-have check (e.g. `lint`) declared on a stack with no such command → `check-absent` error → `failure-policy` retries 3× then escalates. Consistent with the confirmed "error loudly now; align extract-agent check-type vocab in follow-on (1)" stance. (Adversarial N3.)
