# WO-4 (AGENTS.md): consume AGENTS.md as a command source — Implementation Plan (v2, independently reviewed)

> **For agentic workers:** REQUIRED SUB-SKILL — use **superpowers:subagent-driven-development** (or **superpowers:executing-plans**). Steps use checkbox (`- [ ]`) syntax. TDD: failing test → see it fail → implement → see it pass → lint + typecheck + full suite → commit.

**Goal:** make `styre setup` **consume the repo's `AGENTS.md`** — the agent-onboarding standard (Linux-Foundation-governed; ~20k repos per the freeze, *number unverified, freeze §13*) — as an **authoritative command source**. Today the discovery agent refines commands from the repo + ecosystem conventions but is never explicitly handed the repo's own declared build/test/lint commands. This plan reads root `AGENTS.md` deterministically and injects it into the discovery prompt so the agent **prefers the maintainers' declared commands** over ecosystem guesses. AGENTS.md half of WO-4 only (CI-reading stays deferred behind the freeze §13 pilot).

**Architecture:** a pure leaf `readAgentsMd(repoDir)` helper (FS I/O with its own error handling — mirrors the existing `manifests.ts` leaf, not WO-13's inlined `stackSummary`) + a new `{{agents_md}}` placeholder threaded into the existing `discoverComponents` prompt (`prompts/setup-discover.md`). **No change to the M-A trust gate, schema, or merge logic** — AGENTS.md-derived commands flow through the *same* `discover.ts` gating (metachar ban + headless-reject-unless-`--trust-agent-commands` + probe + operator confirm) as any agent command.

**Tech Stack:** TypeScript, Bun (`bun test`), Biome. Use `bun test` · `bun run lint` · `bun run typecheck`.

## Why this design

- **Deterministic file read + bounded agent interpretation** — the freeze's "deterministic-scan → bounded agent-draft → operator-confirm → frozen" shape. AGENTS.md is free-form prose, so agent interpretation is the right tool; a deterministic command-extractor would be fragile *and* would bypass the gate.
- **No new trust, no new execution path** (verified by the security review): the only pipeline change is adding `agents_md` to the `renderPrompt` vars. AGENTS.md bytes never reach a command slot except via the agent's emitted commands, which ride the **identical** gate. A metachar payload (`; curl|sh`) is dropped by `isCommandSafe`; in headless mode without `--trust-agent-commands`, agent overrides are rejected **regardless of content** (`discover.ts:40,59`). `repoCommands` and agent-added command keys are gated too.
- **Do NOT auto-trust AGENTS.md.** Auto-trusting a committed repo file reopens F1 by construction. A finer `--trust-agents-md` model ("trust the declared file but not free agent invention") is a **separate future decision**, out of scope.

## Headless value depends on `--trust-agent-commands` (state this — security review item 5)

Under the M-A headless default, `trusted = interactive(false) || trustAgentCommands(false) = false`, so **every** agent command override (including AGENTS.md-influenced ones) is rejected and falls back to the deterministic scan command. So AGENTS.md delivers **command** value in exactly two modes:
- **Interactive** (`trusted=true`) — AGENTS.md commands flow to the operator confirm.
- **Headless with `--trust-agent-commands`** (`trusted=true`) — the **intended Docker-per-instance bench config** (the sandbox contains the metachar-free residual); AGENTS.md commands accepted, still metachar+probe gated.

Under **bare headless (no flag)**, AGENTS.md influences the prompt but all resulting overrides are rejected **by design** (fallback to scan). This is not a bug; the plan tests it explicitly so it can't be mistaken for one. (Path/kind refinement from the agent is unaffected by the command gate, so AGENTS.md can still improve those even bare-headless.)

## Security & residual risks (security review)

- **The gate is metachar-hygiene + probe + trust — not a sandbox.** A **metachar-free-but-harmful** command (`rm -rf build`, `git push --force`, `./scripts/ci.sh`) passes `isCommandSafe` + probe and, in any *trusted* mode, reaches the slot and later runs via `sh -c`. This residual is **pre-existing** (documented in the M-A findings + `command-safety.ts`), **not introduced** by WO-4. AGENTS.md does not make it safe; it is mitigated by interactive operator confirm and (for the bench) environment isolation.
- **Interactive confirm shows no provenance** (`setup.ts:145-153`): the operator can't tell an AGENTS.md command from a scan/agent one, and AGENTS.md raises transcription fidelity of an attacker-chosen string framed as "the maintainers' declaration" — a **marginal amplification** of an accepted residual. Per-command provenance tagging at confirm is the eventual mitigation but needs provenance threading this WO declines; documented, not built.
- **Backstops in the design's favor:** the discovery agent runs the read-only `setup:discover` allowlist (no write/`gh`/Linear tools — capability isolation), so injection can only influence *proposed commands* (which the gate covers), never an agent action; zod (`DiscoverSchema`) backstops the output **shape**; and `renderPrompt` is a **single-pass** substitution (`render-prompt.ts:26`) — AGENTS.md content containing `{{…}}` is inert literal text, no re-interpolation. The 16 KB cap bounds bloat/surface, **not** a security control.
- **Symlink escape — fixed here:** `readAgentsMd` uses `lstatSync` (not `statSync`) so a symlinked `AGENTS.md → /etc/passwd` / `~/.ssh/id_rsa` is rejected → `""`. Without this, the *deterministic* layer would read an arbitrary host file into the prompt/transcript/telemetry.

## Global Constraints

- **Additive / behavior-preserving:** no `ProfileSchema`/`ComponentSchema`/gate change; the merge + M-A logic is untouched except adding one prompt var. Repos with no AGENTS.md behave exactly as today (the new var renders `""`).
- **Existing suites stay green:** `test/setup/discover.test.ts` asserts merge/gating *outputs*, not prompt text; the repo root has no `AGENTS.md` (confirmed) and the existing tests pass `process.cwd()` / a nonexistent `/tmp` dir → `readAgentsMd` returns `""`. Adding the `{{agents_md}}` placeholder requires the matching var (`renderPrompt` returns `ok:false` otherwise → `discoverComponents` early-returns `fallback`, a real guard).
- **Never throws / no stdout:** `readAgentsMd` is absent-safe; setup advisories go to stderr.

---

### Task 1 — read AGENTS.md (symlink-safe) and inject it into the discovery prompt

**Files:**
- Create: `src/setup/agents-md.ts` (`readAgentsMd`)
- Modify: `src/setup/discover.ts` (read AGENTS.md; add `agents_md` to the render vars)
- Modify: `prompts/setup-discover.md` (add the `{{agents_md}}` block)
- Test: `test/setup/agents-md.test.ts` (new — unit), `test/setup/discover.test.ts` (add integration + headless-no-op cases)

**Interface:** `export function readAgentsMd(repoDir: string): string` — root `AGENTS.md`, **rejects symlinks** (`lstatSync`), capped at `AGENTS_MD_CAP` (16384) bytes with a `\n…[truncated]` marker; `""` when absent/symlink/unreadable/not-a-file. Never throws.

- [ ] **Step 1: Write the failing unit tests** — `test/setup/agents-md.test.ts`:

```ts
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { readAgentsMd } from "../../src/setup/agents-md.ts";

function tmp(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-agents-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("readAgentsMd returns '' when there is no AGENTS.md", () => {
  expect(readAgentsMd(tmp())).toBe("");
});

test("readAgentsMd returns the file content when present", () => {
  expect(readAgentsMd(tmp({ "AGENTS.md": "# Build\nrun `make test` to test\n" }))).toContain("make test");
});

test("readAgentsMd truncates oversized files with a marker", () => {
  const big = "x".repeat(20_000);
  const out = readAgentsMd(tmp({ "AGENTS.md": big }));
  expect(out.length).toBeLessThan(big.length);
  expect(out).toContain("[truncated]");
});

test("readAgentsMd ignores a symlinked AGENTS.md (no host-file read)", () => {
  const secretDir = tmp({ "secret.txt": "SENSITIVE-HOST-DATA" });
  const dir = tmp();
  symlinkSync(join(secretDir, "secret.txt"), join(dir, "AGENTS.md"));
  expect(readAgentsMd(dir)).toBe("");
});
```

- [ ] **Step 2: Run — FAIL** (`readAgentsMd` undefined). `bun test test/setup/agents-md.test.ts`

- [ ] **Step 3: Implement** `src/setup/agents-md.ts`:

```ts
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Cap injected AGENTS.md content — bounds prompt growth and prompt-injection surface (not a
 *  security control). */
export const AGENTS_MD_CAP = 16_384;

/** Read the repo's root AGENTS.md (the agent-onboarding standard). Returns "" when absent,
 *  a symlink, unreadable, or not a regular file (never throws) — `lstatSync` rejects symlinks so a
 *  hostile `AGENTS.md -> /etc/passwd` cannot read a host file into the prompt. Oversized files are
 *  truncated with a marker. */
export function readAgentsMd(repoDir: string): string {
  const path = join(repoDir, "AGENTS.md");
  try {
    if (!lstatSync(path).isFile()) return ""; // isFile() is false for symlinks and directories
    const text = readFileSync(path, "utf8");
    return text.length <= AGENTS_MD_CAP ? text : `${text.slice(0, AGENTS_MD_CAP)}\n…[truncated]`;
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Write the failing integration tests** in `test/setup/discover.test.ts` (RED-first — add BEFORE wiring `discover.ts`; add `import { mkdtempSync, writeFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";` — the file already imports `FakeAgentRunner`, `DEFAULT_AGENT_CONFIG`, `ok`, `sidecar`, `SCAN_COMPONENTS`):

```ts
test("AGENTS.md content is injected into the discovery prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-discover-agents-"));
  writeFileSync(join(dir, "AGENTS.md"), "Run `bun run test` for tests.");
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify({ components: [], repoCommands: {} }))));
  await discoverComponents(dir, { components: SCAN_COMPONENTS, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG });
  expect(runner.inputs[0].prompt).toContain("bun run test");
});

// Security review item 5: AGENTS.md does NOT elevate trust — a headless-untrusted override is
// still rejected and falls back to the deterministic scan command.
test("headless without --trust-agent-commands: AGENTS.md-influenced override is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "styre-discover-headless-"));
  writeFileSync(join(dir, "AGENTS.md"), "Test with `true`.");
  const proposal = {
    components: [{ name: "rust-core", kind: "rust", paths: ["src-tauri/**", "crates/**"],
      commands: { test: "true" } }], // a safe override the agent took from AGENTS.md
    repoCommands: {},
  };
  const runner = new FakeAgentRunner(() => ok(sidecar(JSON.stringify(proposal))));
  const out = await discoverComponents(dir, { components: SCAN_COMPONENTS, repoCommands: {} },
    { runner, agentConfig: DEFAULT_AGENT_CONFIG }, { interactive: false, trustAgentCommands: false });
  const rust = out.components.find((c) => c.name === "rust-core");
  expect(rust?.commands.test).toBe("cargo test --workspace"); // scan value kept, not "true"
  expect(out.warnings.some((w) => w.includes("headless"))).toBe(true);
});
```

- [ ] **Step 5: Run — FAIL** — the injection test throws (`runner.inputs[0]` undefined: missing `agents_md` var ⇒ `renderPrompt` `ok:false` ⇒ early `fallback`, no run). `bun test test/setup/discover.test.ts`

- [ ] **Step 6: Wire `discover.ts`.** Import `readAgentsMd`; replace the render call (wire the empty string directly — no fallback note; `renderPrompt` treats a present `""` value as satisfied):

```ts
const rendered = renderPrompt(discoverTemplate, {
  draft: JSON.stringify(scan.components),
  agents_md: readAgentsMd(repoDir),
});
```
(Everything after — runner call, `mergeComponents`, the M-A gating loop — unchanged.)

- [ ] **Step 7: Add the prompt block** to `prompts/setup-discover.md`, immediately before `Emit exactly one fenced block`:

```markdown
## AGENTS.md (the repo's agent-onboarding standard — authoritative for commands)

{{agents_md}}

If the AGENTS.md above states build/test/lint/check commands, PREFER them over ecosystem defaults
when refining each component's `commands` and `repoCommands` — it is the maintainers' own declaration
of how to build and test this repo. (Your proposed commands are still validated and, in headless
mode, gated — never propose unsafe shell.)
```

- [ ] **Step 8: Run — PASS** + full suite + lint + typecheck. Confirm existing `discover.test.ts` cases are unaffected. `bun test && bun run lint && bun run typecheck`.
- [ ] **Step 9: Commit** — `git commit -m "feat(setup): consume AGENTS.md as an authoritative command source (WO-4)"`

---

## Self-review notes (author)

- **WO-4 coverage (AGENTS.md slice):** the AGENTS.md command source → Task 1. **CI-reading deferred** (freeze §13 pilot). Precedence "CI > AGENTS.md > conventions" expressed as prompt guidance ("prefer AGENTS.md over ecosystem defaults"); CI slots above later.
- **Security:** no new trust/execution path (verified); symlink escape fixed (`lstatSync`); content capped; residuals documented above (not pretended-away). Headless command-value is conditional on `--trust-agent-commands` (the Docker-bench config) — stated and tested.
- **Why not deterministic extraction:** AGENTS.md is prose; a parser would be fragile *and* bypass the gate.
- **Tier-2 limitation (unchanged):** `mergeComponents` drops agent-invented components, so AGENTS.md refines existing components + `repoCommands` but cannot create a component for an undetected stack — deferred Tier-2 path.
- **Scope held:** root `AGENTS.md` only (nested/monorepo + predecessor files like `CLAUDE.md`/`.cursorrules` out of scope); auto-trust model deferred; no schema change; additive.
- **Behavior preservation:** repos without AGENTS.md unaffected (the new var is `""`); existing discover suites pass unchanged (Step 8 verifies).
