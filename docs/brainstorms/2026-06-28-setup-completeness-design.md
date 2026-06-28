# `styre setup` completeness — registry-driven polyglot detection (design v2)

**Status:** Design v2 — revised after an independent 4-reviewer pass (feasibility / scope / adversarial / security). Pending operator review.
**Date:** 2026-06-28
**Builds on:** the polyglot-setup arc (M-A security hardening + M-B detectors) on `feat/polyglot-setup`. Next milestone ("M-C").
**Frame (operator-chosen):** *capability bar + bounded first-class set + cheap extension* — scoped by the `styre setup` feature's own completeness contract, **not** by the downstream SWE-bench goal.

## 0. What the 4-reviewer pass changed (v1 → v2)

- **Deterministic root scoping (was the #1 error).** v1 said a root component gets `["**"]` and "the agent narrows it." Three reviewers proved the agent **cannot** narrow paths — `mergeComponents` only unions/widens (`discover-schema.ts:40`) — and M-A actively *strips* `["**"]` from agent output as dangerous. v2: the **engine** scopes root components deterministically; the agent is labelling/gap-fill, never path-correctness.
- **Over-verify, never under-verify.** v1's "best-effort" reactor member parsing could silently *under-verify* (a missed module → its diffs match no component → verify runs nothing → untested merge). v2: low-confidence member parsing degrades to **one component at the workspace root** (runs everything), never to parsed-member globs.
- **Guard the machine channel.** M-A's `..`/unanchored-glob path guard and `isCommandSafe` were wired **only** to *agent* output; the engine's own paths/commands bypass them. v2 makes both **executable invariants** over all engine output.
- **`prepare`/install is detect-only** (operator decision): setup detects+stores a config-aware `prepare` command but does **not** run it; actually running install — and provisioning base toolchains (`bun`/`npm`/…) — is a separate downstream **environment** workstream spanning setup/verify/run (§8).
- Plus: containment-based member-skip (not "generalize Node"), a non-root phantom guard, kind-qualified component names, and ladder fixes (PHP Pest, Python Django).

---

## 1. The capability bar — what "supported" means

- **Detection** — recognized wherever its manifest appears: **root**, **subdir** (non-root single-module, §3, behind a phantom guard), or across **modules** (multi-module, §3).
- **Commands** — resolves, config-aware, the command classes it can: **`test`** (verify's ground-truth gate, the must-have), best-effort **`build`**/**`check`**, and a **detected-but-not-executed `prepare`** (install/bootstrap; §5/§8). "Config-aware" honestly means *config-driven where the repo declares a runner, ecosystem-default otherwise* — and the ecosystem default **may not run** on an unusual repo, so resolving to `{ unavailable: true }` → the operator/agent ladder is an *expected common outcome* for unusual repos, not a rare one.
- **Routing** — verify maps a diff → impacted component(s) by `paths` → runs their commands. Unchanged (`impactedComponents`, `components.ts`).

"Complete" = the bar met for the first-class set **and** adding a stack is one registry entry.

## 2. Architecture — a `LangDef` registry + a generic engine

Replaces the hardcoded branches in `detect-components.ts`.

```ts
interface LangDef {
  kind: string;                    // "rust" | "node" | "python" | "go" | "jvm-maven" | "jvm-gradle" | "ruby" | "php"
  manifests: string[];             // DATA: anchor files
  // HOOK (optional): multi-manifest handling. Absent ⇒ single-module (one component per manifest dir).
  //   reactor:true  → collapse members into ONE component; reactor:false → one component per member.
  workspace?: (dir: string) => { reactor: boolean; members: string[]; confident: boolean } | null;
  // HOOK: config-aware command resolution for ONE component dir.
  commands: (dir: string) => Partial<Record<"prepare" | "build" | "test" | "check", string>>;
}
const REGISTRY: LangDef[] = [ /* the 8 first-class entries, §4 */ ];
```

**Engine** (`detectComponents(repoDir)`, same `{ components, repoCommands }` signature out): for each `LangDef`, walk for its manifests (SKIP-respecting + the §3 phantom guard); apply `workspace` to decide collapse/per-module/single + §3 scoping; resolve `commands(dir)`; then enforce the **two security invariants** below over every emitted component before returning.

**Security invariants (executable, not prose) — §5 of the M-A findings generalized to the machine channel:**
1. **Path normalization.** Every engine-emitted path (incl. workspace-member-derived globs) passes the *same* guard M-A applies to agent paths: drop any unanchored (`^*`) or `..`-segment glob. A repo declaring `members = ["*"]` cannot produce an always-matching component. *(Centralize member→path conversion so this is unbypassable.)*
2. **Command backstop.** Every resolver-produced command string passes `isCommandSafe` before it can reach the profile. Machine commands are already metachar-free → zero false positives; this converts the previously **un-gated** machine command channel (`discover.ts:54` keeps scan commands verbatim, never checking them) into a gated one. **Resolvers MUST select a fixed command string and MUST NOT interpolate any repo-derived token** (module/member/script name) into it; a stack needing per-module targeting must pass the token through a `[A-Za-z0-9._/-]` allowlist first.

**Why the registry (honest justification — not the deferred tail):** it has **8 concrete consumers today**, and it **unifies four otherwise-divergent mechanisms** the bar now demands uniformly across all of them — reactor collapse (Cargo/Maven/Gradle/go.work), non-root detection, the security normalization above, and the `prepare`/`test`/`build`/`check` resolution contract. The simpler "just add Ruby/PHP as two more `existsSync` branches" alternative was weighed and rejected: it would leave the bar (non-root, multi-module, machine-channel guards) implemented inconsistently per-branch. The §8 long tail is a *bonus*, not the justification.

**Files:** `src/setup/lang/<stack>.ts` (one `LangDef` each), `src/setup/registry.ts` (assembles `REGISTRY`), `src/setup/detect-components.ts` (the generic engine + the two invariants; keeps `findManifests`/`SKIP`).

## 3. Repo-shape policy

**Root single-module — deterministic scoping (the forced fix):**
- A root component is emitted with `["**"]` **only if it is the sole stack rooted at the repo root.**
- When **≥2 stacks co-locate at the root** (e.g. a SvelteKit `package.json` beside a `src-tauri/Cargo.toml`), the engine scopes each deterministically to its owned dirs — preserving the existing Node carve-out (`["src/**","static/**","package.json"]`, `detect-components.ts:156`) as the general pattern, and **excluding the top-level dirs that root other detected components**. Never bare `["**"]` for a co-located root. The agent pass may relabel/gap-fill but is never the mechanism that establishes path correctness (it provably can't narrow).

**Non-root single-module — behind a phantom guard:** a manifest in a subdir → a component scoped to that subdir, **only if** it passes a guard: (a) extended SKIP now also excludes `examples`/`example`/`fixtures`/`testdata`/`e2e`/`templates`/`third_party`/`docs`, and (b) a **corroborating signal** is required (an adjacent lockfile, or a recognized source layout) before emitting a non-root component with a live `test` command. If a subdir manifest is found but not corroborated, **keep the M-B downgraded warning** (it fails *safe* — no component, operator informed) rather than auto-emitting a component verify will trust. The operator-confirm step (§5) lists all auto-detected non-root components explicitly.

**Multi-module — idiomatic, degrading to over-verify:**
- **Unifying rule:** *collapse to one component when the ecosystem's canonical test command operates on the whole workspace* (Maven/Gradle reactor, `cargo test --workspace`, `go test ./...` with `go.work`); *split per-member when it doesn't* (npm/pnpm/yarn workspaces). Cargo/Go *can* target per-package — collapsing them is a deliberate choice (cost: a diff reruns the whole-workspace suite, no per-module routing); acceptable under the idiomatic frame.
- **Member-skip by containment (new logic, not "generalize Node"):** for a reactor component rooted at `R`, skip *all* same-language manifests beneath `R` by directory-prefix containment — **independent of** how well the member list parsed. Partial member parsing then only loosens the collapsed glob, never leaks duplicate components.
- **Degrade to over-verify:** the `workspace` hook returns `confident`. When a reactor marker exists but members can't be resolved confidently, emit **one component scoped to the workspace root `["**"]`** (runs the reactor command on everything) — **never** parsed-member globs that could under-verify a missed module.

## 4. The first-class registry (8 entries)

| kind | manifests | workspace | `test` (precedence) | `prepare` (detect-only) |
|---|---|---|---|---|
| `rust` | `Cargo.toml` | `[workspace].members`→reactor | `cargo test --workspace` / `cargo test` | — (cargo fetches) |
| `node` | `package.json` | npm/pnpm/yarn ws→per-member | `<pm> run test` (pm via `detectPackageManager`) | `<pm> ci`/`install` (lockfile) |
| `python` | `pyproject.toml`/`setup.py`/`requirements.txt` | — | `manage.py`→`python manage.py test` › tox→`tox` › nox→`nox` › pytest-cfg→`pytest` › `python -m pytest` | `pip install -e .` (editable/pyproject) |
| `go` | `go.mod` | `go.work`→reactor | `go test ./...` | — (go fetches) |
| `jvm-maven` | `pom.xml` | `<modules>`→reactor | `<mvnw\|mvn> -q test` | — (mvn fetches) |
| `jvm-gradle` | `build.gradle[.kts]` | `settings.gradle` includes→reactor | `<gradlew\|gradle> test` | — (gradle fetches) |
| `ruby` | `Gemfile` | — | `spec/`·`.rspec`→`rspec` › `test/`→`rake test` › `rake`; `bundle exec` if `Gemfile.lock` | `bundle install` (Gemfile.lock) |
| `php` | `composer.json` | — | `scripts.test`→`composer test` › **Pest (`tests/Pest.php`)→`vendor/bin/pest`** › `phpunit.xml[.dist]`→`vendor/bin/phpunit` › `composer test` | `composer install` (composer.lock) |

Ladder fixes from review: **PHP checks Pest *before* phpunit** (Pest repos also ship `phpunit.xml.dist`); **Python adds the Django `manage.py test` rung**; Ruby's `rake` fallback is best-effort (Rakefile-less minitest repos → may resolve `unavailable` → ladder). Every command above is a **fixed string** (no repo-token interpolation — §2 invariant 2).

## 5. Flow, agent role, M-A interaction

Engine sits where `detectComponents` does: **registry scan → agent refine (always-on, M-A-gated) → operator confirm → profile.**

**M-A interaction (corrected — the guards were agent-only):** registry-resolved commands are machine-authored and now pass the §2 command backstop; the agent's overrides remain gated by the trust rule (`discover.ts:59`). The §2 path normalization now also covers machine-derived member paths (previously un-guarded). So M-A's properties are not merely "unchanged" — they are **extended to the machine channel** that v1 wrongly assumed was already covered.

**`prepare` is detected and stored, not executed:** resolvers produce `prepare` and it persists in `Component.commands`, but verify does **not** run it in this milestone. Running install + provisioning base toolchains is the downstream environment workstream (§8).

**Agent-role tension (named honestly):** on a clean first-class repo the registry is the correctness source; the agent's command overrides are rejected headless and it cannot narrow paths, so its real residual contribution is `kind` relabeling, `repoCommands`, and genuinely-fuzzy/extension-path cases. The operator chose to keep it always-on; this is that, with eyes open.

## 6. Migration

- Existing Rust/Node + M-B Python/Go/JVM detectors become `LangDef`s under `src/setup/lang/*`; `pythonTestCommand`, `cargoWorkspaceMembers`/`collapseWorkspaceGlobs`, the Node scripts logic relocate there. Node reuses `detectPackageManager` (`detect.ts:7`) instead of hardcoding `npm run`.
- **Component names are kind-qualified** (`<kind>-<dir>`) and engine-deduped — a subdir holding two manifests (`services/api/{go.mod,package.json}`) must not collide to one name (the agent-refine reconciliation maps by name, `discover.ts:41` — a collision routes the wrong commands).
- The M-B `unrootedManifestWarnings` is **downgraded, not removed** — it now fires only for *uncorroborated* subdir manifests (§3). Its `cli/setup.ts` import + `console.warn` loop (`setup.ts:12,131`) stay (adjusted), not deleted.
- `ComponentSchema`/signature unchanged; `probe.ts` and downstream untouched. Pre-release → no data migration.

## 7. Testing

- **Per-language fixture matrix** (`test/setup/lang/<stack>.test.ts`): root, non-root (corroborated *and* uncorroborated → warning), reactor-collapse, npm per-member, command-precedence ladders (incl. PHP Pest-before-phpunit, Python Django).
- **Engine:** reactor member-skip by containment; **reactor low-confidence → workspace-root `["**"]`** (over-verify); **co-located root → deterministic scoping, no bare `["**"]`**; polyglot repo → correct per-stack routing; name-collision dedup.
- **Security (executable invariants):** adversarial-manifest fixtures — `Cargo.toml`/`pom.xml`/`settings.gradle`/`pnpm-workspace.yaml` with member values `*`, `**`, top-level-dir, `../x` → assert emitted paths are anchored, no `..`, no unanchored glob; a **registry-conformance test** running every resolver over the fixture matrix (incl. metacharacter-laden script/module names) asserting every produced command passes `isCommandSafe`.
- **M-A regression:** machine commands now pass the backstop; agent overrides still gated.

## 8. Out of scope / deferred

- **Environment provisioning (explicit downstream workstream):** acquiring base toolchains (`bun`/`npm`/`go`/`mvn`/…) and actually **running `prepare`/install** before verify — spans setup, verify, and run. `prepare` is *detected and stored* here; its execution + the toolchain question are designed separately. The "runnable test" bar (§1) is therefore *runnable given a provisioned environment*.
- **iOS / Android** — a separate future feature (device-dependent build/test).
- **C/C++, .NET, Swift, Elixir, Scala, Dart, …** — the extension path (one registry entry each), when a consumer needs them.
- **allowlist-based `verifyEnv`, per-command confirm, cross-stack contract verification** — pre-existing deferrals, unchanged.

## 9. Resolved / remaining open questions

- **Root path scoping** → RESOLVED: deterministic engine scoping (§3); the agent-narrowing escape hatch does not exist.
- **Reactor parse fidelity** → RESOLVED on the safe side: containment-based skip + degrade-to-over-verify (`["**"]` workspace root) when low-confidence; never under-verify.
- **Machine-channel guards** → RESOLVED: §2 invariants apply `isCommandSafe` + path normalization to engine output.
- **Still genuinely open (for the plan):** the exact deterministic carve-out for a co-located root component (preserve Node's `src/**`+`static/**` heuristic vs. compute "root minus sibling-component dirs"); the precise corroborating-signal set for non-root detection.
