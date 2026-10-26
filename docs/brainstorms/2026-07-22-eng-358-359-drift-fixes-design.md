# Two per-ecosystem drift fixes — design (ENG-358, ENG-359)

**Date:** 2026-07-22
**Status:** design, awaiting review
**Tickets:** ENG-358 (`Gemfile`/`composer.json` never re-arm provision), ENG-359 (`SOURCE_EXTS` drift)
**Origin:** both found during the ENG-344 language-stack-registry design, as evidence that scattered per-ecosystem tables drift. Each is a ~2-line fix needing no registry, so they ship independently rather than riding ENG-344.

---

## 1. Why these are separate tickets

The ENG-344 design cited both bugs as motivation for centralising per-ecosystem facts. Three independent reviewers pointed out that bundling them made the registry look load-bearing for bugs it is not: each is fixable in about two lines today. Splitting them out also lets the eventual refactors (ENG-360, ENG-361) claim "no behavior change", which they cannot while carrying a bug fix.

Both ship as their own `fix/` PR. Neither touches the registry, so neither waits on ENG-344.

---

## 2. ENG-358 — `Gemfile`/`composer.json` never re-arm provision

### The bug

`diffTouchesManifest` (`provision.ts:211`) decides whether an `implement` dispatch's committed diff changed a dependency manifest. If it did, `resetProvisionIfManifestTouched` re-arms the once-gated `provision` step so the install re-runs before the next verify.

Its basename set (`provision.ts:192-203`) is hand-maintained and covers node and python only:

```
package.json, package-lock.json, yarn.lock, pnpm-lock.yaml,
pyproject.toml, setup.py, setup.cfg, poetry.lock, Pipfile, Pipfile.lock
```
plus `REQUIREMENTS_RE` for `requirements*.txt`.

**Ruby and PHP are missing, and both are prepare-bearing** — `ruby.ts:30` emits `bundle install`, `php.ts:36` emits `composer install`. So an implement dispatch that adds a gem or a composer package commits the manifest change, provision stays `succeeded`, and the next verify runs against a worktree that never installed the new dependency.

### The fix

Add four basenames: `Gemfile`, `Gemfile.lock`, `composer.json`, `composer.lock`.

### Scope decision: only the prepare-bearing ecosystems

Rust, Go and both JVM kinds have no `prepare`, so `planProvision` (`provision.ts:57`) emits nothing for them. Adding `Cargo.toml`/`go.mod`/`pom.xml` would re-arm provision for no benefit — and in a polyglot repo it has a real if minor cost: a `Cargo.toml` edit in a rust+python repo would re-run the python component's `pip install -e .`, because `resetProvisionIfManifestTouched` resets the **ticket-level** provision step, not a per-component one.

ENG-360 will later derive this set from the registry and pick those manifests up as a deliberate, separately-reviewed change. This ticket fixes the bug and nothing else.

### Behavior change

A Ruby or PHP dependency edit mid-run now re-arms provision. That is the fix, and it is strictly more correct — the previous behavior could only ever under-install.

### Testing

Extend `test/dispatch/provision.test.ts`:
- `diffTouchesManifest` is true for each of the four new basenames.
- Path-independent: a nested `svc/Gemfile` counts (matches on basename, consistent with existing behavior).
- The existing positives (node/python manifests, `requirements-dev.txt`) and negatives (`src/index.ts`, `[]`) are unchanged.

---

## 3. ENG-359 — `SOURCE_EXTS` drift

### The bug

Two tables answer "which file extensions belong to an ecosystem" and disagree:

- `EXTENSIONS_BY_KIND` (`components.ts:10-20`) — authoritative for file-identity routing. Dot-less union: 23 entries.
- `SOURCE_EXTS` (`check-rules.ts:4-19`) — strips a trailing source extension when reducing a path to a module leaf. 15 entries.

The eight missing from `SOURCE_EXTS`: `svelte`, `gradle`, `groovy`, `cts`, `mts`, `kts`, `rake`, `gemspec`.

### What `SOURCE_EXTS` actually gates

`moduleLeaf` (`check-rules.ts:24-31`) serves `importErrorImplicatesDiscarded` (`check-selector.ts:262`) — the discard-poison guard. When a check goes red and this dispatch discarded undeclared files, the guard asks whether the red is *caused by* the discard rather than being a genuine failure. It applies `moduleLeaf` to two things: discarded **check file paths**, and module references parsed out of the runner's raw output.

The leaf tier is one of four, and it is **gated per language** by `LanguageRules.tiesByLeaf`:

| Rules object | `tiesByLeaf` |
|---|---|
| `pythonRules`, `nodeRules`, `rustRules`, `rubyRules`, `phpRules` | `true` |
| `goRules`, `jvmRules` | **`false`** |

### The eight, re-scored

That gating materially shrinks the fix:

| Extension | Owning kind → rules | Live? |
|---|---|---|
| `.svelte` `.cts` `.mts` | sveltekit/node → `nodeRules` (`true`) | **Yes — the genuine gap** |
| `.rake` `.gemspec` | ruby → `rubyRules` (`true`) | Live but implausible: ruby checks are `_test.rb`/`_spec.rb` (`ruby.ts:29`), never a gemspec |
| `.groovy` `.kts` `.gradle` | jvm-maven/jvm-gradle → `jvmRules` (**`false`**) | **Inert** — the leaf tier never runs for JVM |

So the real correction is three node extensions. An earlier reading of this design claimed `.groovy` was the strongest case because Spock specs are Groovy test files; that is wrong — Spock runs under `junit-maven`/`junit-gradle`, whose rules disable the leaf tier entirely.

### Risk direction: errs safe

`handlers.ts:712-720` — when the guard returns a non-empty `implicated`, the check is routed to the uncovered/loud-retry path and **not** persisted as covering its criterion.

Adding extensions shortens leaves, so more discarded files tie to the output, so *more* reds are attributed to the discard. Over-matching costs a retry. Under-matching installs a permanently-broken check as covered — a silent bad merge, which is the failure this guard exists to prevent. The change therefore moves in the conservative direction.

### Scope decision: all eight, one list

Add all eight rather than only the three live ones. Two reasons:

1. **It settles a question ENG-361 depends on.** ENG-361 derives `SOURCE_EXTS` from the registry's routing extensions, making the two identical by construction. That is only correct if they *are* one list. Adding only the "true source" extensions would assert the opposite and force ENG-361's Task 5 to be reworked around a second per-kind field.
2. **The five non-live entries are inert, not wrong.** Three are unreachable (`tiesByLeaf: false` for JVM); two require a discarded check file to be a `.rake` or `.gemspec`, which no detector's `testFilePattern` can produce.

There is a principled argument for the other side — a build manifest like `build.gradle` has no meaningful "module leaf", and reducing it to `build` is semantically odd. It is recorded here and rejected on the grounds that it buys precision in unreachable code while making a real, useful derivation impossible.

`SOURCE_EXTS` stays a hand-maintained set in this ticket. Deriving it is ENG-361's job, and doing it here would drag in the registry this fix is meant not to need.

### Behavior change

`moduleLeaf` reduces eight more extensions. The observable effect is confined to node checks: a red check whose output references a discarded `.svelte`, `.cts` or `.mts` helper is now recognised as poisoned and routed to loud retry, instead of being persisted as covered.

### Testing

New file `test/dispatch/check-rules.test.ts` (it does not exist today):
- Each of the eight reduces correctly, including the two non-obvious ones — `build.gradle.kts` → `gradle` (pops `kts`, then takes the last remaining dotted segment) and `styre.gemspec` → `styre`.
- The extensions already handled still reduce as before (`checks/helper.py` → `helper`, `pkg.helper` → `helper`, `util` → `util`).
- A non-source extension keeps its leaf: `config.yaml` → `yaml`.

Run `bun test test/dispatch/` after the change. Any check-matching test that shifts is the drift being corrected — update it deliberately and record it in the PR body rather than reverting the widening.

---

## 4. Out of scope

- **Deriving either list from the stack registry** — ENG-360 (`MANIFEST_BASENAMES`) and ENG-361 (`SOURCE_EXTS`).
- **Adding the no-install ecosystems' manifests** to `MANIFEST_BASENAMES` — ENG-360, as a deliberate change with its own review.
- **A per-component provision reset.** `resetProvisionIfManifestTouched` resets the ticket-level step, so any manifest touch re-runs every prepare-bearing component's install. Making that per-component is a real improvement and a separate ticket; it is what makes the ENG-358 scope decision matter.
- **`REQUIREMENTS_RE`** and the rest of the manifest-matching logic — untouched.

## 5. Acceptance criteria

**ENG-358**
- [ ] `diffTouchesManifest` returns true for `Gemfile`, `Gemfile.lock`, `composer.json`, `composer.lock`, at any path depth.
- [ ] Existing positives and negatives unchanged; no manifests added for ecosystems without a `prepare`.
- [ ] `bun run format` + `lint` + `typecheck` + `test` green.

**ENG-359**
- [ ] `SOURCE_EXTS` contains all 23 dot-less extensions from `EXTENSIONS_BY_KIND`.
- [ ] `moduleLeaf` covered by tests for all eight additions, the pre-existing entries, and a non-source control.
- [ ] Any check-matching expectation that shifts is updated deliberately and noted in the PR body.
- [ ] `bun run format` + `lint` + `typecheck` + `test` green.

## 6. Refs

- ENG-358: `src/dispatch/provision.ts:192-216`; `src/setup/lang/{ruby,php}.ts`; `test/dispatch/provision.test.ts`
- ENG-359: `src/dispatch/check-rules.ts:4-31,343-361`; `src/dispatch/check-selector.ts:248-335`; `src/dispatch/handlers.ts:694-720`; `src/dispatch/components.ts:10-20`
- Origin: `docs/brainstorms/2026-07-22-eng-344-language-stack-registry-design.md` §1, §6.3, §6.4
- Downstream: ENG-360 (manifest union), ENG-361 (`SOURCE_EXTS` derivation — depends on §3's one-list decision)
