# ENG-367 — remove `pyi` from `SOURCE_EXTS`

*Plan. 2026-07-23. Branch `fix/eng-367-source-exts-drop-pyi`, off `f886319`. **Option A approved; implemented in this branch.** A later whole-branch review found the effect ledger below incomplete — see the `SOURCE_EXTS` doc comment for the corrected FOUR-effect version.*
*Revised after independent review of the plan; every claim below was verified by execution.*

## The defect

`pyi` is the last entry in `SOURCE_EXTS` failing that list's own membership rule: a `.pyi` stub is
never imported by CPython (PEP 484 — stubs are consumed by type checkers at analysis time; the
import system's `SOURCE_SUFFIXES` is `['.py']`). So stripping it can only manufacture ties.

**What actually has to happen to hit it.** `discarded` is not the repo's stub tree — it is
`offendingNew` (`run-dispatch.ts:211,245`): files the *agent authored in this dispatch* that are both
new and out of commit scope. So the trigger is "the check-authoring agent wrote a `.pyi` and it was
discarded", which is rarer than "the repo has stubs". The original ticket framing ("any ordinary
typed python codebase with a `stubs/` tree") overstated it.

**But the blast radius is wider than the ticket claimed.** The false tie is not only intra-language —
because `discarded` is dispatch-wide while the rules object is chosen by the check's framework, a
discarded `.pyi` also ties to node, ruby, rust and php checks. All verified:

```
                                                                    BASELINE          AFTER
pytest  "No module named 'helper'"        + ["stubs/helper.pyi"] -> ["stubs/…"]        []
vitest  "Cannot find module './helper'"   + ["stubs/helper.pyi"] -> ["stubs/…"]        []
rspec   "cannot load such file -- helper" + ["stubs/helper.pyi"] -> ["stubs/…"]        []
```

The genuinely missing module is `helper.py`; the stub is unrelated. Cost per false tie: the
acceptance criterion is left uncovered, the dispatch throws (`handlers.ts:712-717` sets `missReason`
and continues to the loud-retry path), and the ticket escalates to a human after 3 attempts.

## Corollary 1 — does removal lose a true match? No.

`.pyi` is unimportable at runtime, so a discarded stub can never be causal for a **test-runner**
failure — and the guard only ever sees test-command output (`binaryFor(fw)`, `handlers.ts:668`).
`CheckFramework` has no type-checker member, so a mypy-style check cannot reach `CHECK_RULES` at all
except as a pytest plugin's stdout.

For that residual case, verified inert on current mypy phrasings — `Cannot find implementation or
library stub for module named "helper"`, `Library stubs not installed`, `Duplicate module named`,
`Skipping analyzing` all yield `tie: []`, `excerpt: undefined`. Scoped claim, not a universal one:
**legacy** mypy (<0.7) emitted `Cannot find module named 'helper'`, which *does* hit the `cannot find
module` indicator — but it still ties no `.pyi`, so the conclusion holds either way.

If a type-checker framework is ever added, its own rules object is where that belongs — not the
shared extension list.

## Corollary 2 — the two-sided effect (the ENG-365 lesson, applied up front)

ENG-365 shipped claiming "one-directional" and was wrong, because `SOURCE_EXTS` is read on **both**
sides of the comparison. Doing that analysis before implementing this time. Removal has three
distinct effects, not one:

**(a) It kills the false ties** — the table above. The point of the ticket.

**(b) It GAINS a true tie**, exactly as removing `go` did. Verified:

```
"No module named 'mypkg.pyi'" + discarded ["mypkg/pyi.py"]   BASELINE -> []   AFTER -> ["mypkg/pyi.py"]
```

A python package may hold a submodule named `pyi`; stripping popped `.pyi` off a genuine module
*reference*, so the discarded `mypkg/pyi.py` never tied and a genuinely poisoned check was persisted
as covering its criterion. This makes B strictly worse than the table below would otherwise suggest.

**(c) It gains a narrow false tie.** Every discarded `.pyi` now reduces to the constant leaf `pyi`,
so an output reference that also reduces to `pyi` implicates all of them. The necessary condition is
a captured reference literally ending `.pyi` — which is **either** a submodule named `pyi` **or a
captured file path ending `.pyi`**, since `LEGACY_NAMING`'s class is `([\w./-]+)` and accepts `/`
and `.`. (An earlier draft of this plan said "a submodule named `pyi`" only; review caught that as
too tight, the same over-claim pattern this ticket exists to clean up.) Verified:

```
"could not import stubs/helper.pyi" + discarded ["other/thing.pyi"]  BASELINE -> []  AFTER -> ["other/…"]
```

Judged acceptable: no realistic tool message of that shape was found — pytest prints the path but the
*captured* token is the module (`ERROR stubs/helper.pyi - ModuleNotFoundError: No module named
'helper'` captures `helper`) — and the consequence is a spurious retry, never a wrong verdict. It
will be pinned as current behaviour the way ENG-365's residual is, not left undocumented.

**(d) Bonus, minor.** `moduleLeaf("types.d.pyi")` goes from the generic `d` — which collides with the
already-pinned `foo.d.ts` → `d` hazard (`check-rules.test.ts:88-91`) — to `pyi`. Small improvement.

## THE DECISION FOR YOU — standalone, or fold into ENG-366?

| | **A — ship standalone now (recommended)** | **B — fold into ENG-366** |
| --- | --- | --- |
| The live false ties (all 5 languages) | fixed immediately | only when ENG-366 lands |
| Output side | gains a true tie (b); gains the narrow path-shaped residual (c) | **preserves a known-wrong reduction** — the missed true tie (b) stays broken |
| Residual | (c), pinned and documented | none |
| Churn | see caveat below | none |

**Recommendation: A**, and review independently reached the same conclusion. B is not the "clean"
option it first appeared to be: it leaves effect (b) — a genuinely poisoned check silently passing —
unfixed, which is a *wrong-verdict-class* miss, worse than the spurious-retry residual it avoids.

**Caveat on the earlier "reachable incrementally" claim, now withdrawn.** A previous draft said that
after ENG-366 the output-side list "may carry `pyi` again". That is wrong: restoring it re-breaks
effect (b). ENG-366 as specified fixes only the *discarded* side; it does not teach the output side to
distinguish a module reference from a file path. So ENG-366 does **not** subsume this ticket, and if
ENG-366 is picked up first its design must address that or it will regress both this ticket's and
ENG-365's output-side gains.

**Take B only if** ENG-366 is being picked up immediately *and* you accept leaving (b) broken until
then.

## Steps (option A)

1. **Reproduce on unmodified source** — the five false ties above; confirm they are the leaf tier,
   not bounded-basename, by keeping the basename out of the output.
2. **Pin both sides before changing anything** — today's `moduleLeaf("stubs/helper.pyi")` is `helper`,
   and a captured `helper.pyi` reference also reduces to `helper`, so the two-sided effect is
   explicit in the diff.
3. **Remove** `"pyi"` from `SOURCE_EXTS` (`src/dispatch/check-rules.ts:50`). One line.
4. **Doc comment** — add `pyi` to the "Excluded on that rule" list with the runtime-vs-analysis-time
   reasoning, and record effects (b), (c) and (d) honestly beside ENG-365's residual. Do **not**
   claim a clean win. `EXTENSIONS_BY_KIND` keeps `.pyi` (`components.ts:14`): it is the file→component
   **routing** map, explicitly disjoint from this list, and `.pyi` genuinely is a python file for
   routing purposes. Do not touch it.
5. **Tests** — (i) the intra-language false tie is gone; (ii) at least one **cross-language** fix
   (vitest/rspec + a discarded `.pyi` → `[]`); (iii) the **gained true tie** (b), which is the
   evidence this is not merely a narrowing; (iv) the path-shaped residual (c), pinned as current
   behaviour; (v) `moduleLeaf` on a `.pyi` no longer yields the stem.
6. **Full suite.** Verified in advance that no pre-existing test moves — with `pyi` removed the suite
   is 1568 pass / 0 fail, identical to baseline. Any regression is still investigated, not updated.
7. `bun run format` + `lint` + `typecheck` + `test`; commit, push, draft PR, independent review of
   the diff.

## Risk

Low. One line of source; the only behavioural surface is the leaf tier of one guard. Both directions
of error there are a spurious retry or a missed retry, never a wrong merge verdict. No schema,
projector, or outward write path is touched.
