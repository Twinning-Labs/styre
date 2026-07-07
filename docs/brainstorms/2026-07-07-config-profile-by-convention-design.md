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
  `no profile for '<slug>' at <path> — run \`styre setup\` first`. cwd is not a git repo (and no
  `--profile`) → an error telling the operator to `cd` into the repo or pass `--profile`. An explicit
  `--profile <path>` stays an exact override, so CI/fleet callers passing a path are byte-for-byte
  unaffected.

- **DEC-CV-3 — Config-by-convention applies to BOTH `run` and `setup`, via shallow per-key merge.**
  When `--config` is omitted, discover the workspace config by merging the **raw** JSON of
  `config.json` (global) then `<slug>/config.json` (per-project) — **shallow, per top-level key**:
  a higher tier's present keys override the lower tier's, and the nested `agent` block is **replaced
  wholesale** when a higher tier sets it (RuntimeConfig is flat scalars + one nested `agent`). The
  merged object is then `RuntimeConfigSchema.parse`'d so binary defaults fill any gaps. Missing files
  are skipped (each file may be partial or absent). Resulting precedence (no `--config`):
  **per-project `<slug>/config.json` > global `config.json` > binary defaults.** The per-ticket tier
  stays commercial-deferred (build-operations §4).

- **DEC-CV-4 — Explicit flags are HERMETIC, per axis and independent.** `--config <path>`, when
  passed, is the **sole** runtime-config source — convention discovery is skipped entirely, so a
  CI/fleet caller that passes `--config` never silently inherits a stray host `~/.config/styre`
  file. Likewise `--profile <path>` is the exact profile. The two axes are independent: omitting
  `--profile` triggers profile-convention without affecting where config comes from, and vice-versa.
  This preserves the one-shot primitive's explicit contract: `styre run --profile P --config C`
  behaves exactly as it does today.

- **DEC-CV-5 — Slug derivation is shared, not re-implemented.** Export the existing `deriveSlug` from
  `src/setup/probe.ts` (today it is private) and reuse it in the run-side discovery, so the slug run
  looks up under is guaranteed to match the slug setup wrote under (both call
  `deriveSlug(<same repo dir>)`: `remote.origin.url` → GitHub repo name, else `basename(repoDir)`).

## 3. Architecture

```
src/config/
  paths.ts        # UNCHANGED — configDir(), stateDir(), defaultDbPath()
  discover.ts     # NEW — profile + runtime-config discovery-by-convention (pure, injectable fs/git)
  runtime-config.ts / agent-config.ts   # UNCHANGED (schemas)
src/setup/
  probe.ts        # CHANGED — export `deriveSlug` (was private)
src/cli/
  run.ts          # CHANGED — --profile optional; resolve profile + runtime config via discover.ts
  setup.ts        # CHANGED — resolve runtime config via discover.ts (agent/provider by convention)
```

**`src/config/discover.ts` (the whole surface):**

- `slugForCwd(cwd = process.cwd()): string | null` — `discoverRepoRoot(cwd)` then `deriveSlug(root)`;
  returns `null` when cwd is not a git repo (so callers can produce a precise error).
- `profilePathFor(slug: string): string` = `join(configDir(), slug, "profile.json")`.
- `discoverRuntimeConfig(opts: { explicitPath?: string; slug?: string }): RuntimeConfig`:
  - `explicitPath` present → `RuntimeConfigSchema.parse(JSON.parse(read(explicitPath)))` **alone**
    (hermetic; today's behavior).
  - else → read global `configDir()/config.json` and (if `slug`) `configDir()/<slug>/config.json`,
    each optional; shallow-merge raw `{...global, ...perProject}`; `RuntimeConfigSchema.parse(merged)`.
  - fs/git are injected (default real) so it is unit-testable without touching `~/.config`.

**`styre run` flow (the only behavior change users see):**

```
resolve slug   := args.profile ? (load & use its slug) : slugForCwd()   // null → error if no --profile
profile        := args.profile ? loadProfile(args.profile)
                                : loadProfile(profilePathFor(slug))       // ENOENT → "run styre setup first"
runtimeConfig  := discoverRuntimeConfig({ explicitPath: args.config, slug })
agentConfig    := runtimeConfig.agent ?? DEFAULT_AGENT_CONFIG              // unchanged (#54)
```

`styre setup` gains only the config side. Its credential gate + `resolveAgentRunner` run *before*
`probeProfile`, so setup derives the slug up-front from the already-discovered repo
(`deriveSlug(repo)` — the same value `probeProfile` will compute) and feeds it to
`runtimeConfig := discoverRuntimeConfig({ explicitPath: args.config, slug })`; the provider-aware
gate + `resolveAgentRunner` then read `runtimeConfig.agent` (unchanged from #54, just fed by
convention now).

## 4. Error handling & edge cases

- **cwd not a git repo, no `--profile`** → `styre run: no --profile given and the current directory is
  not a git repo — cd into the target repo or pass --profile`.
- **slug-derived profile absent** → `styre run: no profile for '<slug>' at <path> — run \`styre setup\`
  first` (never a silent fallback to a stale/foreign profile).
- **malformed `config.json` / `<slug>/config.json`** → error naming the offending file (a bad
  convention file must fail loudly, not be silently skipped — only *absence* is skipped).
- **explicit `--config` / `--profile` missing or malformed** → error as today (unchanged).
- **`--profile` given, cwd is a different repo** → honored as today: the profile's `targetRepo`
  governs (in-place mode already reconciles a cwd/targetRepo mismatch and warns). Convention only
  derives slug from cwd when `--profile` is omitted, in which case cwd *is* the repo.
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
- **backward-compat**: existing run/setup tests that pass `--profile`/`--config` are unchanged and
  must stay green (the explicit path is the hermetic branch).
- CI never touches the real `~/.config` — `configDir()` is overridable via `XDG_CONFIG_HOME`, which
  the tests set to a tmp dir.

## 6. What is NOT changing

Schemas (`RuntimeConfigSchema`, `AgentConfigSchema`, `ProfileSchema`) are untouched — this is purely
a *resolution* layer in front of them. `styre setup`'s profile-writing path and slug derivation are
unchanged. The per-ticket config tier stays commercial-deferred. No schema migration. The
`--profile`/`--config` explicit contract is preserved exactly (hermetic branch), so the CI/fleet
primitive is unaffected.

## 7. Migration / sequencing

1. Export `deriveSlug` from `probe.ts` (was private) — trivial, unblocks reuse.
2. `src/config/discover.ts` + `discover.test.ts` — pure, fully unit-tested, no wiring yet.
3. Wire `styre run` — `--profile` optional + `discoverRuntimeConfig`; default (explicit-flag) behavior
   preserved; add run-level tests.
4. Wire `styre setup` — `discoverRuntimeConfig` for the agent/provider; preserve the explicit
   `--config` behavior + the `ANTHROPIC_API_KEY` default-path gate message.
5. Docs — a README "Running by convention" section (the XDG layout + zero-flag `styre run`, and how to
   set the Codex `agent` block globally) + a build-operations §4 pointer noting the loader now exists.

Per repo workflow: a `feat/` branch, PR into `main`, operator merges — no auto-merge.
