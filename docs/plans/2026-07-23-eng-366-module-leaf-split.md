# ENG-366 — split `moduleLeaf` by side

**Status:** implemented. Approved option A (accept the §4.2 loss, pin it, file follow-ups). Follow-ups
filed: ENG-368 (output-side `moduleLeaf` path-shaped stripping), ENG-369 (`.vue`/importable exts),
ENG-370 (the two second-class `LEGACY_NAMING` phrases). ENG-369 blocked-by ENG-366 + ENG-368.
**Ticket:** ENG-366 — *fix(checks): split moduleLeaf by side — a discarded path is not a module reference*
**Base:** `origin/main` @ `f5cf8b4` (ENG-365 and ENG-367 both landed)
**Branch:** `fix/eng-366-module-leaf-split`

---

## 1. The defect, in one paragraph

`importErrorImplicatesDiscarded` calls the *same* function, `moduleLeaf`, on two structurally
different inputs and declares a tie when they agree:

| side | call site | input | example |
| -- | -- | -- | -- |
| output | `check-selector.ts:283` | a module **reference** parsed out of runner output | `mypkg.go`, `./Button`, `../build` |
| discarded | `check-selector.ts:325` | a **file path** on disk | `cmd/build.go`, `src/lib/Button.svelte` |

For a reference, the last dotted segment genuinely *is* the leaf — `mypkg.go` names a submodule
called `go`. For a file path, the last dotted segment is an **extension**, and when that extension
is not in `SOURCE_EXTS` today's code returns the extension itself as though it were an identifier.
So `cmd/build.go` → `"go"`, and it collides with a real python reference `mypkg.go` → `"go"`.

## 2. The fix

Give the discarded side its own reduction. A discarded path whose extension no `tiesByLeaf`
language can import cannot be the cause of an import error, so it reduces to `""` — which the leaf
tier **already skips**. No new branch at the call site:

```ts
// check-selector.ts:326 — unchanged
if (leaf !== "" && leaves.has(leaf)) hit = true;
```

```ts
/** The leaf of a discarded FILE PATH, or "" when the path is not importable … */
export function importableLeaf(path: string): string {
  const seg = path.split(/[\\/]/).pop() ?? path;
  const parts = seg.split(".").filter((s) => s.length > 0);
  if (parts.length < 2) return "";                                    // no extension at all
  if (!SOURCE_EXTS.has((parts[parts.length - 1] ?? "").toLowerCase())) return "";
  parts.pop();
  return (parts[parts.length - 1] ?? "").toLowerCase();
}
```

`moduleLeaf` is untouched and keeps serving line 283 only.

**Measured** (probe run against the real `main` definitions, not reasoned):

| discarded path | today | after | effect |
| -- | -- | -- | -- |
| `cmd/build.go` | `go` | `""` | **fixes** the ENG-365 residual |
| `src/Build.java` | `java` | `""` | same class |
| `stubs/helper.pyi` | `pyi` | `""` | **fixes** the ENG-367 residual (see §4.4) |
| `types.d.pyi` | `pyi` | `""` | same class |
| `Main.kts` | `kts` | `""` | same class |
| `infra/build.gradle` | `gradle` | `""` | no-op — `gradle` never matched anything |
| `config.yaml` / `data.json` | `yaml` / `json` | `""` | **behaviour change, see §4.2** |
| `scripts/deploy` | `deploy` | `""` | **fixes** an unfiled collision (§4.1) |
| `Makefile` | `makefile` | `""` | same class |
| `.env` | `env` | `""` | same class |
| `mypkg/go.py` | `go` | `go` | true tie **preserved** — the case that proves this isn't a blanket narrowing |
| `checks/helper.py` | `helper` | `helper` | unchanged |
| `src/lib/Button.svelte` | `button` | `button` | unchanged |
| `spec/user_spec.rb` | `user_spec` | `user_spec` | unchanged |
| `src/mod.rs` | `mod` | `mod` | unchanged (the rust `mod.rs` shape rule still applies) |
| `utils.test.mts` / `types.d.mts` | `test` / `d` | `test` / `d` | unchanged — the multi-dot CAVEAT is **not** fixed here (filed separately) |

## 3. Decisions I need from you

### D1 — extensionless discarded paths reduce to `""`

`scripts/deploy`, `Makefile`, `.env` currently yield a leaf and would stop. **Recommend: yes,
accept.** Nothing extensionless is importable in any `tiesByLeaf` ecosystem — python resolves
`SOURCE_SUFFIXES`, node's resolver appends extensions rather than accepting a bare file, cargo/rspec/
minitest/phpunit likewise. The leaf tier exists to explain *import* errors specifically. The loss is
strictly of ties that were coincidences of a filename looking like a module name.

Worth naming the residual honestly: extensionless discarded files now get **no** leaf-tier coverage
and they already had none at the bounded-basename tier (which requires `base.includes(".")`). If
such a file really is the cause, only a shape rule can catch it. I judge that correct rather than a
gap — but it is a real narrowing and shouldn't land by accident.

### D2 — naming, and whether the two functions share code

**Recommend `importableLeaf`, sharing only the tokenizer.** `discardedLeaf` names the *call site*;
`importableLeaf` names the *rule* ("the leaf, if this path is importable at all"), which is what a
future third caller would need to know. Both functions need "last path segment, split on dots, drop
empties" — factor that into a private `dotParts(ref)` so the two can't drift on path-separator or
empty-segment handling, and keep the *policy* (what to do when the extension isn't importable)
separate in each. That is the axis they must differ on; everything else they must not.

### D3 — one extension list or two?

The ticket asks me to "confirm `SOURCE_EXTS` is then serving only ONE purpose". **It isn't — it is
still read by both sides — and I recommend keeping one list anyway, but as a pragmatic call, not a
proven identity.**

An earlier draft of this plan argued the two sides' predicates *provably coincide*. Review falsified
that, and I confirmed it. The output-side half of the argument was missing a branch: if `.X` is
importable, the reference `foo.X` may **still** name a submodule literally called `X`, and then
stripping is wrong. Live on `main` today, for every one of the thirteen entries:

```
pytest, "No module named 'mypkg.ts'", discarded ["mypkg/ts.py"]
  moduleLeaf("mypkg.ts") = "mypkg"     importableLeaf("mypkg/ts.py") = "ts"     → guard returns []
```

That is the *same wrong-verdict-class miss* ENG-365 fixed for `.go`/`.java` and ENG-367 for `.pyi` —
still latent for `py js jsx ts tsx mjs cjs cts mts svelte rs rb php`. The sound output-side predicate
is not "is `.X` importable" but "is this reference **path-shaped**" (contains a separator or a
leading `./`). So the two sides genuinely diverge, and the reason to keep one list is only that two
lists would start identical and drift.

**Consequences I'm committing to:**
- Do **not** write the "one predicate, two consequences" framing into the `SOURCE_EXTS` comment.
  Baking a falsified identity claim into that doc comment is the precise recurrence pattern of this
  ticket cluster. State instead: one list, two *different* rules, and name the divergence.
- **AC #4 is partly unsatisfiable as written.** The `RESIDUAL` paragraph goes away (genuinely fixed),
  but the two-sided hedging must stay — it is describing something real.
- File the latent output-side bug as its own ticket (`moduleLeaf` should strip only from path-shaped
  references). Not fixed here: it is output-side, and this ticket is deliberately discarded-side only.

### D4 — the true-tie loss in §4.2: accept, or fix first? **(the one that needs your call)**

See §4.2. Review confirmed my mitigation claim is only conditionally true, so §4.2's own stop-and-ask
trips. My recommendation is **accept the loss and pin it** — reasoning there.

## 4. Effects the ticket doesn't list

### 4.1 The extensionless collision (ticket mentions, unfiled)
`scripts/deploy` → `deploy` today ties to any node check failing on `require('./deploy')`. Fixed.

### 4.2 Constant-token ties that are sometimes TRUE — a real removal, and the tier-4 rescue is only partial

Today a discarded `fixtures/data.json` reduces to the constant `json`, so it ties whenever the output
names *any* reference ending `.json`. Usually false — it implicates every discarded `.json`, not the
named one — but **occasionally true**, when the named one is the only such file. That tie is gone.

**The class is much wider than `.json`/`.yaml`.** The loss condition is: *the discarded extension is
not in `SOURCE_EXTS`, and the output names a reference literally ending in it.* Everything a
`tiesByLeaf` runner can import that is missing from the list qualifies — measured firing today:
`.vue` (the exact peer of `.svelte`, which **is** listed), `.css`/`.scss` (jest/vitest import these
routinely), `.phtml`/`.inc` (php `require`s them constantly; phpunit is `tiesByLeaf`), `.yml`,
`.graphql`, `.mdx`, `.astro`, `.node`. `.vue` is not a fixture file — it is source, and its absence
from `SOURCE_EXTS` (and from `EXTENSIONS_BY_KIND`) looks like a genuine list bug worth filing.

**My mitigation claim was only conditionally true.** Tier 4 is gated on `basenameGates`, which for
python/node is `LEGACY_INDICATORS`. But `LEGACY_NAMING` matches four phrases and **two of them —
`could not import` and `unable to resolve` — are not indicators at all** (verified in
`check-rules.ts:267-280`). For those outputs tier 4 is dead and the leaf tier is the only route:

```
vitest, "could not import ./fixtures/data.json", discarded ["fixtures/data.json"]
  today = ["fixtures/data.json"]     after = []      ← true tie lost, NO tier-4 rescue
vitest, "could not import ./Button.vue",        discarded ["src/lib/Button.vue"]
  today = ["src/lib/Button.vue"]     after = []      ← same, and this one is source
```

When an indicator *is* present (`Cannot find module './fixtures/data.json' from …`), tier 4 does
rescue it — confirmed for jest, and for `.phtml` under phpunit and `.yml` under rspec. So the loss is
bounded to naming-phrase-only output, not universal. But "the true case keeps a path to coverage" was
too strong, and there is an existing test (`check-rules.test.ts:156`) written specifically to pin the
naming-phrase-without-indicator class as one the guard must handle.

**Recommendation: accept the loss, pin it with a test that names it as a known gap, and file the two
real fixes separately.** Reasoning: a constant-token match is not a signal. It fires on *every*
discarded file of that extension and is right only when there happens to be one — the identical
mechanism to the ENG-365 residual this ticket exists to delete. Keeping it means keeping the
false-tie class to preserve a coincidence. The two principled fixes are both separate changes:

- **F-a.** `could not import` / `unable to resolve` are naming phrases that cannot gate the basename
  tier. That is a bug in its own right, independent of this ticket, and fixing it here would widen
  `indicators` — which also drives the excerpt and the `conftest.py` shape rule. Own ticket.
- **F-b.** Widen `SOURCE_EXTS` (`.vue` first, then `.css`/`.phtml`/…). This converts the constant-token
  tie into a real stem tie. Explicitly **not** in this PR: adding entries is bidirectional and would
  land on the output-side bug D3 just uncovered. Much easier to reason about once this split has
  landed and the two consequences can be weighed apart.

**This is the one decision I want confirmed before implementing**, because the failure direction is
the bad one (a lost true tie is a wrong verdict; a lost false tie is only a saved retry).

### 4.3 The discarded side stays framework-blind
`importableLeaf` asks "can *some* `tiesByLeaf` language import this?", while `discarded` is
dispatch-wide and the rules object follows the *check's* framework. So cross-language stem ties
survive untouched — measured: `Cannot find module './helper'` (vitest) + discarded `lib/helper.rb`
→ implicated; `Failed opening required 'helper'` (phpunit) + discarded `src/helper.py` → implicated.
This ticket does not fix that and shouldn't pretend to. The obvious future shape is
`importableLeaf(path, rules)`; I'll document it as a named residual rather than leave it implicit.

### 4.4 It **does** subsume the ENG-367 residual (ticket section is stale)
The ticket's "Does NOT subsume the `pyi` ticket" section was written before ENG-367 merged, when
`pyi` was still in `SOURCE_EXTS`. It now isn't, so a discarded `stubs/helper.pyi` reduces to `""`
under this change and residual (c) in the `SOURCE_EXTS` comment dies with it. The section's
*conclusion* still stands for the right reason: ENG-367 was independently necessary because its
effects (b) and (d) are **output-side**, which this ticket does not touch. I'll correct the ticket.

### 4.5 What this does *not* fix
The multi-dot caveat (`utils.test.mts` → `test`) is untouched on both sides — same behaviour, still
filed separately. Nothing here changes tiers 1, 2 or 4, or any non-`tiesByLeaf` language.

## 5. Implementation steps

1. `check-rules.ts`: add `dotParts` (private) + `importableLeaf` (exported), rewrite `moduleLeaf` on
   top of `dotParts`, with a doc comment that states the shared predicate and the different policy.
2. `check-selector.ts:325`: `moduleLeaf(d)` → `importableLeaf(d)`. Update the import and the
   `importErrorImplicatesDiscarded` doc comment's leaf-tier sentence.
3. `SOURCE_EXTS` comment: delete the ENG-365 `RESIDUAL` paragraph and ENG-367's `(c)`; restate the
   membership rule as importability with its two consequences; keep (a), (b), (d) and the CAVEAT.
4. `check-rules.ts:227` (`modMarkerImplicated`) comment says "`moduleLeaf` yields `mod`" — retarget
   to `importableLeaf`; behaviour unchanged, but a stale name here is exactly how this drifts.
5. Tests (`test/dispatch/check-rules.test.ts`):
   - Split the unit describes: assertions labelled *discarded-path side* move to `importableLeaf`;
     the reference-shaped ones stay on `moduleLeaf`. Path-shaped inputs stay on `moduleLeaf` too
     where they model what a runner actually prints (jest prints `'./a/helper.js'`).
   - **Exactly three existing tests fail** under this change (measured by review against patched
     copies; `check-selector.test.ts` stays fully green). All three currently pin behaviour this
     ticket deliberately removes, so all three get **inverted**, not deleted and not "fixed":
     1. `RESIDUAL: that same output also implicates unrelated discarded Go files` (:246) — AC #2.
     2. `(c) a captured path ending .pyi implicates unrelated discarded stubs` (:366) — ENG-367's
        residual, which §4.4 shows dies here.
     3. `(c) the residual is live on other frameworks too, not just pytest` (:380, rspec + phpunit).
   - Keep and re-assert the `mypkg.go` ↔ `mypkg/go.py` true tie (AC #3).
   - New end-to-end coverage for: extensionless, `Makefile`, `.pyi`, the `.json`/`.vue` losses of
     §4.2 (both the indicator case tier 4 rescues **and** the `could not import` case it does not —
     the latter pinned explicitly as a known gap), the framework-blindness residual of §4.3, and a
     non-`tiesByLeaf` language unaffected.
6. Verify each new negative **bites**: restore the old shared call temporarily and confirm the new
   tests go red. A negative that passes for the wrong reason is the failure mode this whole cluster
   of tickets keeps producing.
7. Re-run the Go/JVM mutation guards in `check-selector.test.ts` (AC #5). Their discarded paths are
   `assert.py` / `api.py`, both importable, so I expect them unaffected and still discriminating —
   but that is a prediction; I'll report what actually happens rather than assume.
8. `bun run format` → `lint` → `typecheck` → `test`.

## 6. Risk

**Moderate, and one-directional this time — but say why, since ENG-365's plan claimed exactly that
and was wrong.** ENG-365 was bidirectional because it edited `SOURCE_EXTS`, which both sides read.
This change edits *only the discarded side's policy* and leaves `moduleLeaf` and the list alone, so
the output side cannot move. Within the discarded side it can only ever turn a leaf into `""`, never
the reverse, so it can only **remove** leaf-tier matches. The whole question is therefore whether any
removed match was true — §4.2 is the only candidate I found, and it has a documented fallback that
will be tested, not assumed.

Failure mode if I'm wrong: a genuinely poisoned check is persisted as covering its criterion (the
wrong-verdict class), which is worse than the spurious-retry class this fixes. That asymmetry is why
step 6 exists and why §4.2 is a stop-and-ask rather than a note.

**Review verified the one-directionality claim structurally** rather than taking it on trust:
`moduleLeaf` has exactly three references in `src/` and only the one at `:325` moves; the two
functions differ *only* where the new one returns `""`, so the discarded side is monotone
leaf→`""`. Across the 171 existing tests plus 21 hand-built cases, every behavioural diff was a
removal and none an addition. So the claim holds this time — and the entire risk collapses into the
single question §4.2 asks: **was any removed match true?**

---

## 7. Review log

Independently reviewed before implementation. Findings that changed the plan, all confirmed by
execution or by direct inspection of `main`:

- **§3 D3's "the two rules provably coincide" was false** — falsified by `moduleLeaf("mypkg.ts")`
  → `mypkg`, the same wrong-verdict miss ENG-365/367 fixed for other extensions, still latent for
  all thirteen entries. Rewritten as pragmatism; a new ticket to file.
- **§4.2's tier-4 mitigation was only conditionally true** — `could not import` and `unable to
  resolve` are naming phrases but not indicators, so tier 4 cannot gate on them. Rewritten; the
  stop-and-ask is now live (D4).
- **§4.2's enumeration was too narrow** — the class includes `.vue` (source, not fixtures),
  `.css`/`.scss`, `.phtml`/`.inc` and more, not just `.json`/`.yaml`.
- **§5 missed two of the three tests that break** — both ENG-367 `(c)` tests.
- **§4.3 (framework-blindness) was absent** — added as a named residual.
- Confirmed unchanged: §2's behavioural table reproduces exactly; D1 (extensionless → `""`) sound,
  with cargo shown to have nothing to lose since its naming capture `(\w+)` admits no dots; §4.4's
  claim that ENG-367's `(b)` and `(d)` survive; §6's one-directionality; step 7's prediction that
  the Go/JVM mutation guards are unaffected and still discriminate.
- Side finding, pre-existing and unrelated: `unable to resolve` mis-captures — `Unable to resolve
  module ./x from …` (Metro/React Native) captures the literal word `module`, not the path, because
  `LEGACY_NAMING` has no optional `module` token. The guard is already blind to that phrasing.
  Worth its own ticket; it also means §4.2's loss rests mainly on `could not import`.
