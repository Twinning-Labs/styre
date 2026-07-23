# ENG-365 — remove `go`/`java`/`kt`/`scala` from `SOURCE_EXTS`

*Plan. 2026-07-23. Branch `fix/eng-365-source-exts-drop-go-jvm`, off `fb48b00`.*

## The defect

`SOURCE_EXTS` (`src/dispatch/check-rules.ts`) is consulted by `moduleLeaf`, which feeds exactly one
thing: the **leaf tier** of `importErrorImplicatesDiscarded` (`src/dispatch/check-selector.ts:324`).
That tier is gated on `rules.tiesByLeaf`, false for `goRules` and `jvmRules`.

`discarded` is **dispatch-wide** and unfiltered by language; the rules object is chosen by the
*check's* framework. So a discarded `.go`/`.java`/`.kt`/`.scala` file is evaluated against node,
python, ruby, rust and php checks — where the leaf tier is live — and stripping its extension
manufactures a tie to a module name that has nothing to do with the failure.

## The corollary the ticket asks me to confirm first

> With `tiesByLeaf: false` for both `goRules` and `jvmRules`, is there **any** live path where
> stripping these produces a true match?

`moduleLeaf` has exactly two call sites, both in `importErrorImplicatesDiscarded`:

| Site | Line | Reached when |
| --- | --- | --- |
| output side — `leaves.add(moduleLeaf(m[1]))` | `check-selector.ts:283` | always, but `leaves` is *read* only under `tiesByLeaf` |
| discarded side — `moduleLeaf(d)` | `check-selector.ts:325` | inside `if (!hit && rules.tiesByLeaf)` |

So the entire blast radius is the five `tiesByLeaf: true` languages: python, node (jest+vitest),
rust, ruby, php. For a true match, **both** sides must reduce to the same leaf:

- **Discarded side.** A tie requires the check to actually import the discarded file. None of those
  five languages can import a `.go`, `.java`, `.kt` or `.scala` file. Every match here is false.
- **Output side.** A tie requires a python/node/ruby/rust/php runner to name a specifier ending in
  `.go`/`.java`/`.kt`/`.scala` — i.e. to claim it tried to import one. Not a genuine import either.

No live path produces a true match. Removal is pure win, as the ticket predicted. Verified by
execution before the source is touched (step 1 below), not asserted from reading.

## The unlocked true tie (beyond the ticket's scope claim)

Stripping is not merely inert on the output side — it is actively **wrong** for one real shape.
A python package with a submodule named `go` (or `java`/`kt`/`scala`) emits
`No module named 'mypkg.go'`. `moduleLeaf` currently pops `.go` as if it were an extension, giving
the leaf `mypkg`; the discarded file `mypkg/go.py` reduces to `go`. The two never meet, so a
**genuine** poisoned check is missed today. Removal fixes that as well. Pinned by a test, because
it is the strongest possible evidence the change is not merely a narrowing.

## Steps

1. **Reproduce first, on unmodified source.** Write the three false ties from the ticket plus a
   `.scala` fourth and the missed-true-tie case above as failing tests; run them; confirm the three
   false ties currently return the discarded file and the true tie currently returns `[]`.
2. **Remove** `"go"`, `"java"`, `"kt"`, `"scala"` from `SOURCE_EXTS`.
3. **Doc comment.** Delete the `GRANDFATHERED` paragraph. Fold the four into the existing
   "Excluded on that rule" list beside `kts`/`groovy`, which they now sit alongside on identical
   reasoning. The list then satisfies its own stated rule with no exceptions.
4. **Replace** the `grandfathered entries that fail the current scope rule` describe block with one
   asserting the four are **not** stripped. Move `moduleLeaf("Foo.java")` out of
   `extensions already handled` (line 16) into it — that assertion changes by direct intent, which
   is the investigation the ticket's "no blind updates" criterion asks for.
5. **Full suite.** Any *other* regression is investigated, not updated. Expected non-regressions:
   the go/JVM smoke cells (`scope-disposition-smoke.test.ts:1365,1515`) tie by the shape and symbol
   tiers, which never call `moduleLeaf`.
6. `bun run format` + `lint` + `typecheck` + `test`.
7. Commit, push, open a **draft** PR. Independent review of the bounded diff.

## Risk

Low, and one-directional. The change can only *remove* leaf-tier matches involving these four
extensions, and every such match is provably false (§corollary). The user-visible effect is that a
polyglot repo stops escalating to a human on a manufactured tie. No schema, no projector, no
outward write path is touched.
