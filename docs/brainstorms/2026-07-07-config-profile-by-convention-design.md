# Config & Profile by Convention — Design

> Make `styre run` work with **zero path flags** by discovering the profile and workspace config
> from their conventional XDG locations, instead of forcing `--profile` and `--config` on every
> invocation. Closes two long-standing deferred carries ("`styre run` profile auto-discovery by slug
> from configDir" and "config-source loader: workspace `config.json`/`$XDG_CONFIG_HOME` discovery +
> merge"). Status: **proposed** 2026-07-07.

---

## 1. Why

`styre setup` already writes the profile to a conventional XDG location —
`$XDG_CONFIG_HOME/styre/<slug>/profile.json` (`configDir()`, `setup.ts` outPath). But nothing reads
it back by convention: `styre run --profile` is `required: true` and does a plain
`loadProfile(args.profile)`, and `--config` only reads the explicit path handed to it. So an operator
who just ran `styre setup` must still pass both paths on every `styre run`, even though one of them
was just written to a well-known place. The convention is **written but not read**.

This friction is most visible right after the Codex work (#54): to switch a project to Codex you now
hand-author a `config.json` and pass `--config` (plus `--profile`) every single run. The intended UX
is `cd my-repo && styre run ENG-123` — provider, models, and profile all resolved by convention, set
once.

The pieces already exist: `configDir()` (`src/config/paths.ts`), `deriveSlug(repo)`
(`src/setup/probe.ts`), `discoverRepoRoot()` (`src/dispatch/in-place.ts`), and the documented
precedence **workspace `config.json` > profile > defaults** (build-operations §4; the per-ticket tier
is commercial-deferred). This design wires them together.

## 2. Decisions

- **DEC-CV-1 — The conventional layout under `configDir()`.** `configDir()` =
  `$XDG_CONFIG_HOME/styre` (default `~/.config/styre`). Three conventional files, all keyed by
  `deriveSlug(repo)`:
  - `~/.config/styre/config.json` — **global** workspace config (applies to every project).
  - `~/.config/styre/<slug>/config.json` — **per-project** workspace config (overrides global).
  - `~/.config/styre/<slug>/profile.json` — the per-project profile, **written by `styre setup`**
    (unchanged; already the setup default out-path).

- **DEC-CV-2 — Profile-by-convention is a `styre run` concern only.** `styre setup` *produces* the
  profile, so it needs no profile input (unchanged). For `styre run`, `--profile` becomes
  **optional**; when omitted, run: (1) discovers the cwd git repo via `discoverRepoRoot()`, (2)
  derives the slug with the same `deriveSlug` setup used, (3) loads
  `configDir()/<slug>/profile.json`. A missing profile → a clear error:
  `no profile for '<slug>' at <path> — run \`styre setup\` first`. This message fires **only** on
  ENOENT (missing file); a *present but malformed* profile surfaces as its parse/zod error, never the
  "run setup" message (don't tell the operator to re-run setup when setup already ran). cwd is not a
  git repo (and no `--profile`) → an error telling the operator to `cd` into the repo or pass
  `--profile`. An explicit `--profile <path>` stays an exact override, so CI/fleet callers passing a
  path are byte-for-byte unaffected. `styre run` also gains an optional `--slug <name>` escape hatch
  (see DEC-CV-5) for repos whose profile was written under a custom `setup --slug`.

- **DEC-CV-3 — Config-by-convention applies to BOTH `run` and `setup`, via shallow per-key merge.**
  When `--config` is omitted, discover the workspace config by merging the **raw** JSON of
  `config.json` (global) then `<slug>/config.json` (per-project) — **shallow, per top-level key**:
  a higher tier's present keys override the lower tier's, and the nested `agent` block is **replaced
  wholesale** when a higher tier sets it (RuntimeConfig is flat scalars + one nested `agent`). The
  merged object is then `RuntimeConfigSchema.parse`'d so binary defaults fill any gaps. Missing files
  are skipped (each file may be partial or absent). Resulting precedence (no `--config`):
  **per-project `<slug>/config.json` > global `config.json` > binary defaults.** The per-ticket tier
  stays commercial-deferred (build-operations §4).

  **`agent` is all-or-nothing.** Because merge is a raw spread (`{...global, ...perProject}`) *then*
  `.parse()`, and `AgentConfigSchema` requires `provider` + full `models.{deep,standard,cheap}` with
  no defaults, a higher tier that sets `agent` must supply the **complete** block — a partial `agent`
  (e.g. just `provider`) discards the lower tier's `agent` and then fails `.parse()`. So "set the
  Codex agent block globally" means writing the full block once in `config.json`; you cannot override
  only `agent.models.deep` per-project (that is the DEC-CV-3 "shallow, not deep" choice made
  explicit). `discover.test.ts` covers the partial-`agent` throw.

- **DEC-CV-4 — Explicit flags are HERMETIC, per axis and independent.** `--config <path>`, when
  passed, is the **sole** runtime-config source — convention discovery is skipped entirely, so a
  CI/fleet caller that passes `--config` never silently inherits a stray host `~/.config/styre`
  file. Likewise `--profile <path>` is the exact profile. The two axes are independent: omitting
  `--profile` triggers profile-convention without affecting where config comes from, and vice-versa.
  This preserves the one-shot primitive's explicit contract: `styre run --profile P --config C`
  behaves exactly as it does today.

- **DEC-CV-5 — Shared slug derivation, reconciled with the existing `setup --slug` override.** Move
  `deriveSlug` out of `src/setup/probe.ts` (today private) into a small dependency-free module so both
  setup and the new discovery reuse it (`remote.origin.url` → GitHub repo name, else
  `basename(repoDir)`). The slug-match guarantee holds **only when setup used the derived slug**:
  `styre setup` already exposes `--slug <name>` (`setup.ts:199` → `probeProfile` override), which
  writes the profile under `configDir()/<override>/`. Zero-flag `styre run` computes the *derived*
  slug and would miss that profile. Reconciliation: (a) setup computes its effective slug **once** as
  `args.slug ?? deriveSlug(repo)` and uses it for **both** the profile write *and* its config-convention
  lookup (so a `--slug` project keeps its config + profile in the **same** `<slug>/` dir, not split);
  (b) `styre run` gains an optional `--slug <name>` mirroring setup — pass it (or `--profile`) for a
  repo set up under a custom slug. Documented: a custom `setup --slug` opts that repo out of pure
  zero-flag run (you then pass `--slug`/`--profile`). The common path — `setup` with no `--slug` —
  needs no flags at run.

- **DEC-CV-6 — `config/` stays a leaf; discovery must not drag heavy deps onto the hot path.**
  `run.ts` today imports `dispatch/in-place.ts` **lazily** (`await import(...)`, `run.ts:72` /
  `setup.ts:221`) precisely to keep its transitive weight (`dispatch/provision.ts`,
  `setup/lang/*`, `util/run-command.ts`) off startup. The new `src/config/discover.ts` must therefore
  NOT statically import `in-place.ts` or the heavy `setup/probe.ts`. So: extract the 9-line
  `discoverRepoRoot` (`in-place.ts:21-29`) and `deriveSlug` into small leaf modules under `src/config/`
  (git + path only, zero app deps); `in-place.ts` and `probe.ts` re-export from there (no behavior
  change). `discover.ts` then depends only on leaves, and `run.ts`/`setup.ts` may import it eagerly
  without loading provision/lang.

## 3. Architecture

```
src/config/
  paths.ts        # UNCHANGED — configDir(), stateDir(), defaultDbPath()
  slug.ts         # NEW (leaf) — deriveSlug(repo) + discoverRepoRoot(cwd) (git + path only, zero app deps)
  discover.ts     # NEW — profile + runtime-config discovery-by-convention (depends only on leaves; injectable fs/git)
  runtime-config.ts / agent-config.ts   # UNCHANGED (schemas)
src/setup/
  probe.ts        # CHANGED — re-export deriveSlug from config/slug.ts (no behavior change)
src/dispatch/
  in-place.ts     # CHANGED — re-export discoverRepoRoot from config/slug.ts (keeps lazy-import callers working)
src/cli/
  run.ts          # CHANGED — --profile optional + --slug; resolve profile + runtime config via discover.ts
  setup.ts        # CHANGED — effective slug = args.slug ?? deriveSlug(repo); resolve runtime config via discover.ts
```

(DEC-CV-6: `deriveSlug`/`discoverRepoRoot` move to the `config/slug.ts` leaf so `discover.ts` — and
thus an eager import from `run.ts` — never pulls `probe.ts`/`in-place.ts`'s heavy transitive deps.)

**`src/config/discover.ts` (the whole surface):**

- `slugForCwd(cwd = process.cwd()): string | null` — `discoverRepoRoot(cwd)` then `deriveSlug(root)`;
  returns `null` when cwd is not a git repo (so callers can produce a precise error).
- `profilePathFor(slug: string): string` = `join(configDir(), slug, "profile.json")`.
- `discoverRuntimeConfig(opts: { explicitPath?: string; slug?: string }): RuntimeConfig`:
  - `explicitPath` present → `RuntimeConfigSchema.parse(JSON.parse(read(explicitPath)))` **alone**
    (hermetic; today's behavior).
  - else → read global `configDir()/config.json` and (if `slug`) `configDir()/<slug>/config.json`,
    each optional; shallow-merge raw `{...global, ...perProject}`; `RuntimeConfigSchema.parse(merged)`.
    *Absence* of a convention file is skipped; a file that is *present but malformed* (bad JSON or
    zod-invalid) throws an error naming the file.
  - fs/git are injected (default real) so it is unit-testable without touching `~/.config`.
- `loadProfileByConvention(slug): Profile` — `existsSync(profilePathFor(slug))` ? `loadProfile(path)`
  : throw the "run `styre setup` first" ENOENT message. `loadProfile` itself throws a raw `ENOENT`
  (`profile.ts:147`), so this helper is what distinguishes *missing* (→ run setup) from *malformed*
  (→ the parse error propagates as-is). Belongs in `discover.ts`, not inlined at the call site.

**`styre run` flow (the only behavior change users see):**

```
if args.profile:                     // explicit → hermetic, exactly as today
    profile := loadProfile(args.profile)
    slug    := args.slug ?? profile.slug        // slug still needed for per-project config lookup
else:
    slug    := args.slug ?? slugForCwd()        // null (not a repo, no --slug) → error: cd in or pass --profile/--slug
    profile := loadProfileByConvention(slug)    // ENOENT → "run styre setup first"; malformed → parse error
runtimeConfig := discoverRuntimeConfig({ explicitPath: args.config, slug })
agentConfig   := runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG    // unchanged (#54)
```
(Discover the repo root once and reuse it; don't re-derive in the later `--in-place` block.)

`styre setup` gains only the config side. Its credential gate + `resolveAgentRunner` run *before*
`probeProfile`, so setup computes its **effective slug** up-front — `effSlug := args.slug ??
deriveSlug(repo)`, the same value `probeProfile` writes the profile under — and feeds it to both
`runtimeConfig := discoverRuntimeConfig({ explicitPath: args.config, slug: effSlug })` **and** the
`probeProfile` slug override. This keeps a `--slug` project's config and profile in the *same*
`configDir()/<effSlug>/` directory. The provider-aware gate + `resolveAgentRunner` then read
`runtimeConfig.agent` (unchanged from #54, just fed by convention now).

## 4. Error handling & edge cases

- **cwd not a git repo, no `--profile`** → `styre run: no --profile given and the current directory is
  not a git repo — cd into the target repo or pass --profile`.
- **slug-derived profile absent** → `styre run: no profile for '<slug>' at <path> — run \`styre setup\`
  first` (never a silent fallback to a stale/foreign profile).
- **malformed `config.json` / `<slug>/config.json`** → error naming the offending file (a bad
  convention file must fail loudly, not be silently skipped — only *absence* is skipped).
- **explicit `--config` / `--profile` missing or malformed** → error as today (unchanged).
- **cwd identifies the profile; `targetRepo` governs the work.** Deriving the slug from cwd only
  *selects which profile* to load; where work actually happens is still `profile.targetRepo` (worktree
  seeded from it; `--in-place` re-discovers cwd and reconciles/warns on mismatch, `run.ts:76-84`). So
  if two checkouts of the same repo share a slug, zero-flag run in checkout A may load a profile whose
  `targetRepo` is checkout B — surprising only in the (already-warned) in-place case; pass `--profile`
  to pin it.
- **A custom `setup --slug`** writes under `configDir()/<override>/`; zero-flag run derives a different
  slug and would report "no profile" — pass `--slug <override>`/`--profile` to run (DEC-CV-5).
- **Typo'd config keys are silently ignored** (`RuntimeConfigSchema` is not `.strict()`) — pre-existing
  behavior; "fail loudly" (above) covers bad JSON / wrong-typed values, NOT unknown-key typos. Adding
  `.strict()` is a separate, larger call (it would also reject forward-compat keys) — out of scope here.
- **`agent` block from a lower tier + a higher tier that omits it** → the lower tier's `agent`
  survives (shallow merge keeps keys the higher tier doesn't set); a higher tier that sets `agent`
  replaces it wholesale (DEC-CV-3).

## 5. Testing

- **`discover.test.ts`** (pure, injected fs/git): explicit path is hermetic (ignores convention files
  present in a fake home); global-only; per-project overrides global per top-level key; `agent`
  replaced wholesale; missing files skipped; malformed file throws naming the file;
  `slugForCwd` returns null off-repo; `profilePathFor` composes the XDG path.
- **run wiring**: `--profile` omitted + a fake `configDir()/<slug>/profile.json` present → loads it;
  absent → the setup-pointing error; `--profile` explicit still overrides.
- **setup wiring**: with a global `config.json` selecting codex, the setup credential gate checks
  `OPENAI_API_KEY` (provider resolved by convention).
- **backward-compat**: tests that pass BOTH `--profile` and `--config` hit only hermetic branches and
  stay green. **One existing test DOES change** (from independent review): `test/cli/
  run-inplace-discovery.test.ts` drives the real `runCommand.run` with `--profile` but **no
  `--config`**, and does not set `XDG_CONFIG_HOME` — after this change its no-`--config` path would
  read the host `~/.config/styre/config.json`. The plan MUST sandbox `XDG_CONFIG_HOME` to a tmp dir in
  that test (and any other test driving the `run`/`setup` wrapper without `--config`). Tests that call
  `runTicket`/`runSetup` directly (`run-e2e.test.ts`, `setup.test.ts`) bypass the wrapper and are
  genuinely unaffected.
- CI never touches the real `~/.config` — `configDir()` is overridable via `XDG_CONFIG_HOME`, which
  every convention-exercising test sets to a tmp dir.

## 6. What is NOT changing

Schemas (`RuntimeConfigSchema`, `AgentConfigSchema`, `ProfileSchema`) are untouched — this is purely
a *resolution* layer in front of them. `styre setup`'s profile-writing path and slug derivation are
unchanged. The per-ticket config tier stays commercial-deferred. No schema migration. The
`--profile`/`--config` explicit contract is preserved exactly (hermetic branch), so the CI/fleet
primitive is unaffected.

## 7. Migration / sequencing

1. Extract `deriveSlug` + `discoverRepoRoot` into `src/config/slug.ts` (leaf); `probe.ts` and
   `in-place.ts` re-export (no behavior change, existing tests green) — DEC-CV-6.
2. `src/config/discover.ts` (`slugForCwd`, `profilePathFor`, `discoverRuntimeConfig`,
   `loadProfileByConvention`) + `discover.test.ts` — pure, injected fs/git, fully unit-tested
   (incl. hermetic explicit-path, global+per-project merge, partial-`agent` throw, ENOENT-vs-malformed).
3. Wire `styre run` — `--profile` optional + `--slug`; `discoverRuntimeConfig`; discover repo root once.
   **Sandbox `XDG_CONFIG_HOME` in `test/cli/run-inplace-discovery.test.ts`** (H1) and add run-level
   convention tests. Explicit-flag behavior preserved.
4. Wire `styre setup` — effective slug `args.slug ?? deriveSlug(repo)` for both config lookup and the
   probe override; `discoverRuntimeConfig` for the agent/provider; preserve the explicit `--config`
   behavior + the `ANTHROPIC_API_KEY` default-path gate message. Sandbox `XDG_CONFIG_HOME` in any
   wrapper-driving setup test lacking `--config`.
5. Docs — a README "Running by convention" section (the XDG layout + zero-flag `styre run`, and how to
   set the Codex `agent` block globally) + a build-operations §4 pointer noting the loader now exists.

Per repo workflow: a `feat/` branch, PR into `main`, operator merges — no auto-merge.

## 8. Independent review (2026-07-07)

A fresh, code-grounded adversarial review verified every citation (all CONFIRMED except two the
design over-promised) and stress-tested each decision. Verdict: **architecturally sound and buildable
as one plan**; the core mechanism (cwd→slug→profile; shallow raw-merge→`.parse()`; hermetic explicit
flags) checks out against the code — RuntimeConfig is genuinely flat-scalars + one optional `agent`,
partials parse, and the explicit-flag contract is byte-preserved. Two must-fixes and several
refinements were folded back in:

- **H1 (was HIGH):** `test/cli/run-inplace-discovery.test.ts` drives the real wrapper with `--profile`
  but no `--config` and doesn't set `XDG_CONFIG_HOME` — after the loader lands it would read host
  `~/.config`. §5 corrected (it is NOT untouched); the plan now sandboxes `XDG_CONFIG_HOME` there.
- **H2/M1 (was HIGH/MED):** the shipped `styre setup --slug` override breaks the slug-match guarantee —
  zero-flag run would report "no profile" for a profile written under a custom slug. DEC-CV-5 now
  qualifies the guarantee, setup uses one effective slug (`args.slug ?? deriveSlug`) for both config
  and profile, and `styre run` gains a `--slug` escape hatch.
- **M2 (was MED):** `config/discover.ts` importing `probe.ts`/`in-place.ts` would drag heavy deps onto
  the startup hot path (run.ts lazy-imports in-place.ts precisely to avoid this). New DEC-CV-6:
  extract `deriveSlug`/`discoverRepoRoot` to a `config/slug.ts` leaf.
- **M3 (was MED):** a partial higher-tier `agent` block hard-errors (`.parse()` requires the full
  block) — DEC-CV-3 now states `agent` is all-or-nothing, covered by a test.
- **L1/L2/L3 (LOW):** "cwd is the repo" reworded to "cwd selects the profile; `targetRepo` governs the
  work"; ENOENT-vs-malformed split via `loadProfileByConvention`; noted that typo'd keys are silently
  dropped (no `.strict()`), so "fail loudly" covers bad values, not unknown keys.

Cleared non-findings: no chicken-and-egg (the profile's `targetRepo` is never needed to *find* the
profile), no true import cycle, and explicit-`--config` hermeticity is exactly backward-compatible.
