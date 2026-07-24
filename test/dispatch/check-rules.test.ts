import { describe, expect, test } from "bun:test";
import { importableLeaf, moduleLeaf } from "../../src/dispatch/check-rules.ts";
import { importErrorImplicatesDiscarded } from "../../src/dispatch/check-selector.ts";

// The leaf tier of the discard-poison guard (`importErrorImplicatesDiscarded`) asks whether a red
// check failed BECAUSE this dispatch discarded a file the check imports. It compares two leaves —
// and after ENG-366 they are computed by TWO DIFFERENT functions, deliberately:
//   - `moduleLeaf`   reduces a module REFERENCE parsed out of the runner's output (output side).
//   - `importableLeaf` reduces a discarded FILE PATH (discarded side), returning "" when the path
//                    is not importable by any tiesByLeaf language — which the tier skips.
// Both read the shared `SOURCE_EXTS`, so adding an entry still changes both sides (ENG-369) — but
// they apply it under different POLICIES: an extension token is a real leaf for a reference naming a
// submodule after it (`mypkg.ts` → submodule `ts`), and never a real leaf for a file PATH. Conflating
// the two was the ENG-365/367 false-tie class. NB the output side is still unsound for
// submodule-after-extension references (`moduleLeaf("mypkg.ts")` → `mypkg`); that half is ENG-368,
// not fixed here, and its tests live with that ticket.

describe("moduleLeaf: extensions already handled", () => {
  // `Foo.java` used to be asserted here as `foo`. ENG-365 removed `java` from SOURCE_EXTS, so it
  // now reduces to `java`; the assertion moved to the not-stripped block below rather than being
  // dropped, because that reduction is the point of the change, not collateral.
  test("reduces a path to its module leaf", () => {
    expect(moduleLeaf("checks/helper.py")).toBe("helper");
    expect(moduleLeaf("./a/helper.js")).toBe("helper");
    expect(moduleLeaf("src/main.rs")).toBe("main");
    expect(moduleLeaf("spec/user_spec.rb")).toBe("user_spec");
  });

  test("reduces a dotted module reference", () => {
    expect(moduleLeaf("pkg.helper")).toBe("helper");
  });

  test("leaves a bare name alone", () => {
    expect(moduleLeaf("util")).toBe("util");
  });
});

describe("moduleLeaf: the node source extensions added by ENG-359", () => {
  // A node check can import any of these, and `nodeRules.tiesByLeaf` is true — so before this
  // fix, a check that went red because its discarded `.svelte`/`.cts`/`.mts` helper was stripped
  // failed to tie, and was persisted as covering its criterion instead of retried loudly.
  test("svelte", () => {
    expect(moduleLeaf("src/Button.svelte")).toBe("button");
    expect(moduleLeaf("../lib/Modal.svelte")).toBe("modal");
  });

  test("cts and mts", () => {
    expect(moduleLeaf("a/helper.cts")).toBe("helper");
    expect(moduleLeaf("a/helper.mts")).toBe("helper");
  });

  // Pin the concrete leaf on each side — NOT `toBe(other)`, which would pass vacuously if both
  // happened to collapse to the same token. The two sides go through DIFFERENT functions now.
  test("both sides of the guard's pairing reduce to the same concrete leaf", () => {
    expect(moduleLeaf("./Button.svelte")).toBe("button"); // output side (a reference)
    expect(importableLeaf("src/lib/Button.svelte")).toBe("button"); // discarded-path side
  });
});

describe("importableLeaf: extensions deliberately NOT importable", () => {
  // These are discarded-side concerns: the guard must not tie a discarded manifest/JVM file to a
  // check just because its stem or extension token happens to collide with a named module. Under
  // ENG-366 that is enforced by `importableLeaf` returning "" — the tier skips "", so no tie is
  // even expressible, a stronger guarantee than the old "keeps its extension token" reduction.
  test("a build manifest is not importable", () => {
    // Nothing imports these; their stems are among the most collision-prone tokens in a repo.
    expect(importableLeaf("infra/build.gradle")).toBe("");
    expect(importableLeaf("tasks.rake")).toBe("");
    expect(importableLeaf("styre.gemspec")).toBe("");
  });

  test("no collision is possible with the module tokens those files sit near", () => {
    // "" can never equal a real output leaf, so a discarded `build.gradle` cannot meet a node check
    // failing on `Cannot find module '../build'`, nor `styre.gemspec` a missing `lib/styre.rb`.
    expect(importableLeaf("infra/build.gradle")).not.toBe(moduleLeaf("../build"));
    expect(importableLeaf("styre.gemspec")).not.toBe(moduleLeaf("lib/styre.rb"));
  });

  // JVM source extensions: `jvmRules.tiesByLeaf` is false, so JVM checks never reach the leaf tier,
  // and a discarded `.kts`/`.groovy` evaluated against a tiesByLeaf check must not tie either.
  test("JVM-only source extensions are not importable", () => {
    expect(importableLeaf("Main.kts")).toBe("");
    expect(importableLeaf("FooSpec.groovy")).toBe("");
  });
});

describe("moduleLeaf: multi-dot stems collapse to the second-to-last segment", () => {
  // `moduleLeaf` pops exactly ONE extension, so a doubled suffix leaves a generic leaf. This is
  // pre-existing (`foo.d.ts` already yields "d") but the .cts/.mts additions widen it, and "test"
  // is collision-prone given the discarded set is exactly agent-authored test files.
  // Pinned here so the behavior is visible rather than surprising; the fix is its own ticket.
  test("a doubled suffix yields the inner segment, not the stem", () => {
    expect(moduleLeaf("types.d.mts")).toBe("d");
    expect(moduleLeaf("types.d.cts")).toBe("d");
    expect(moduleLeaf("utils.test.mts")).toBe("test");
    expect(moduleLeaf("foo.d.ts")).toBe("d"); // pre-existing, unchanged by this fix
  });

  test("a SvelteKit route file keeps its + prefix", () => {
    expect(moduleLeaf("src/routes/+page.svelte")).toBe("+page");
  });
});

describe("importableLeaf: go/JVM source extensions are not importable (ENG-365/366)", () => {
  // These four fail the SOURCE_EXTS membership rule: their languages are tiesByLeaf:false, so no
  // check that CAN import them ever reaches the leaf tier, while every tiesByLeaf language that does
  // reach it could only tie to them falsely. ENG-365 kept them OUT of the list; ENG-366 makes the
  // discarded-side consequence exact — a discarded `.go`/`.java`/`.kt`/`.scala` reduces to "", so
  // the ENG-365 RESIDUAL (a discarded `.go` reducing to the constant token `go`) is gone. The
  // end-to-end consequence is pinned in "the false ties removed by ENG-365" below.
  test("the reduction is empty, not the extension token", () => {
    expect(importableLeaf("cmd/build.go")).toBe("");
    expect(importableLeaf("src/Build.java")).toBe("");
    expect(importableLeaf("jvm/util.kt")).toBe("");
    expect(importableLeaf("jvm/Helper.scala")).toBe("");
  });

  test("no collision with any module token, in either direction", () => {
    // The old false tie: shared `moduleLeaf` reduced `cmd/build.go` to the token `go`, which met a
    // python reference `mypkg.go` (also `go`). "" meets nothing, so neither shape of the tie exists.
    expect(importableLeaf("cmd/build.go")).not.toBe(moduleLeaf("../build"));
    expect(importableLeaf("cmd/build.go")).not.toBe(moduleLeaf("mypkg.go"));
    expect(importableLeaf("jvm/util.kt")).not.toBe(moduleLeaf("util"));
  });

  // The surviving true tie, at the reduction level. `.go` is NOT in SOURCE_EXTS, so the output side
  // does NOT strip it: `moduleLeaf("mypkg.go")` → `go` (a submodule literally named `go`), which
  // meets the discarded `mypkg/go.py` → `go`. Both sides land on `go` through different functions.
  test("both sides land on `go` for the surviving submodule tie", () => {
    expect(moduleLeaf("mypkg.go")).toBe("go");
    expect(importableLeaf("mypkg/go.py")).toBe("go");
  });
});

describe("importableLeaf: non-source extensions and extensionless paths", () => {
  // Data/config files and extensionless files are not importable, so a discarded one cannot be the
  // cause of an import error. Old shared `moduleLeaf` returned the extension token (`yaml`, `json`)
  // or the bare name (`deploy`, `makefile`); `importableLeaf` returns "".
  test("a data/config file is not importable", () => {
    expect(importableLeaf("config.yaml")).toBe("");
    expect(importableLeaf("data.json")).toBe("");
  });

  test("an extensionless file is not importable", () => {
    expect(importableLeaf("scripts/deploy")).toBe("");
    expect(importableLeaf("Makefile")).toBe("");
    expect(importableLeaf(".env")).toBe("");
  });

  // The importable cases importableLeaf must still reduce correctly — the stem before a source
  // extension, lower-cased, one extension popped (the multi-dot CAVEAT applies equally here).
  test("a source file reduces to its stem", () => {
    expect(importableLeaf("checks/helper.py")).toBe("helper");
    expect(importableLeaf("src/main.rs")).toBe("main");
    expect(importableLeaf("spec/user_spec.rb")).toBe("user_spec");
    expect(importableLeaf("a/helper.mts")).toBe("helper");
    expect(importableLeaf("utils.test.mts")).toBe("test"); // one extension popped, CAVEAT
    expect(importableLeaf("Button.SVELTE")).toBe("button"); // extension match is case-insensitive
  });
});

// ─── End-to-end: the guard, not just moduleLeaf ──────────────────────────────
// `moduleLeaf` in isolation says nothing about whether the guard's behavior changed. These pin
// the actual decision: given a red check's output and the files this dispatch discarded, does
// `importErrorImplicatesDiscarded` implicate one?
//
// Note the leaf tier is only ONE of four. The bounded-basename tier already covered the common
// SvelteKit case, because Vite requires the extension in the specifier so the runner's message
// usually carries `Button.svelte` verbatim. The genuinely NEW coverage is narrower:
//   (a) an extensionless specifier,
//   (b) a `.mts` file reached via TypeScript's emitted `.mjs` specifier,
//   (c) a naming phrase that is not also an indicator, which disables the basename tier and
//       leaves the leaf tier as the only path.

describe("importErrorImplicatesDiscarded: the leaf tier after ENG-359", () => {
  const guard = (out: string, discarded: string[]) =>
    importErrorImplicatesDiscarded(out, discarded, "vitest");

  test("(a) an extensionless specifier ties to a discarded .svelte component", () => {
    expect(guard("Error: Cannot find module './Button'", ["src/lib/Button.svelte"])).toEqual([
      "src/lib/Button.svelte",
    ]);
  });

  test("(b) a .mts helper ties via TypeScript's emitted .mjs specifier", () => {
    expect(guard("Error: Cannot find module './helper.mjs'", ["src/helper.mts"])).toEqual([
      "src/helper.mts",
    ]);
  });

  test("(c) a naming phrase that is not an indicator still ties", () => {
    // "could not import" is in the naming patterns but NOT the indicator list, so the
    // bounded-basename tier is disabled and the leaf tier is the only route to a match.
    expect(guard("could not import Button", ["src/lib/Button.svelte"])).toEqual([
      "src/lib/Button.svelte",
    ]);
  });

  test("a build manifest is NOT implicated by a colliding module name", () => {
    // The false tie the gradle/rake/gemspec exclusion exists to prevent.
    expect(guard("Error: Cannot find module '../build'", ["infra/build.gradle"])).toEqual([]);
  });

  test("a red naming an unrelated module implicates nothing", () => {
    expect(guard("Error: Cannot find module './feature'", ["src/lib/Button.svelte"])).toEqual([]);
  });
});

describe("importErrorImplicatesDiscarded: the false ties removed by ENG-365", () => {
  // WHY these are cross-language: `discarded` is dispatch-wide and carries every file this
  // dispatch dropped, whatever its language, while the rules object is chosen by the CHECK's
  // framework. So a discarded .go/.java/.kt/.scala file IS evaluated against node/python/ruby
  // checks — the languages where the leaf tier is live. Each case below returned the discarded
  // file before the fix (verified by running these against unmodified source), which left the
  // acceptance criterion uncovered, threw the dispatch, and escalated to a human after 3 attempts.
  //
  // Each pairing also avoids the bounded-basename tier by construction: the full basename
  // (`build.go`, `Build.java`, …) appears nowhere in the output, so the leaf tier is the only
  // route to a match and these assertions cannot pass for the wrong reason.

  test("a discarded Go file does not tie to a node check's missing module", () => {
    expect(
      importErrorImplicatesDiscarded(
        "Error: Cannot find module '../build'",
        ["cmd/build.go"],
        "vitest",
      ),
    ).toEqual([]);
  });

  test("a discarded Java file does not tie to a jest check's missing module", () => {
    expect(
      importErrorImplicatesDiscarded("Cannot find module './build'", ["src/Build.java"], "jest"),
    ).toEqual([]);
  });

  test("a discarded Kotlin file does not tie to a pytest collection error", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'util'",
        ["jvm/util.kt"],
        "pytest",
      ),
    ).toEqual([]);
  });

  test("a discarded Scala file does not tie to an rspec load error", () => {
    expect(
      importErrorImplicatesDiscarded(
        "LoadError: cannot load such file -- helper",
        ["jvm/Helper.scala"],
        "rspec",
      ),
    ).toEqual([]);
  });

  // The leaf-tie that SURVIVES, and the case that proves ENG-366 is not a blanket narrowing. A
  // python package may legitimately hold a submodule named `go`. `.go` is NOT in SOURCE_EXTS, so
  // `moduleLeaf("mypkg.go")` does not strip it and yields the leaf `go`, which meets the discarded
  // `mypkg/go.py` (`importableLeaf` → `go`) — a genuinely poisoned check ties. Now a CLEAN win under
  // ENG-366: the residual this pairing used to carry is fixed in the test one describe down.
  test("a python submodule named `go` still ties to the file that defines it", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'mypkg.go'",
        ["mypkg/go.py"],
        "pytest",
      ),
    ).toEqual(["mypkg/go.py"]);
  });

  // AC #2 — this was the ENG-365 RESIDUAL, previously pinned as ACCEPTED behavior: the same output
  // that unlocks the true tie above ALSO implicated every unrelated discarded `.go` file, because
  // the shared `moduleLeaf` reduced `cmd/build.go` to the constant token `go`. ENG-366 gives the
  // discarded side `importableLeaf`, which reduces a non-importable `.go` path to "" — so the false
  // tie is GONE while the true tie is untouched. Inverted from the residual assertion it replaces.
  test("FIXED (ENG-366): that same output no longer implicates unrelated discarded Go files", () => {
    const out = "ModuleNotFoundError: No module named 'mypkg.go'";
    // The true tie survives; the unrelated `.go` file no longer rides along on it.
    expect(importErrorImplicatesDiscarded(out, ["mypkg/go.py", "cmd/build.go"], "pytest")).toEqual([
      "mypkg/go.py",
    ]);
    // And with no true tie present at all, the output now implicates nothing.
    expect(importErrorImplicatesDiscarded(out, ["cmd/build.go"], "pytest")).toEqual([]);
  });
});

describe("importErrorImplicatesDiscarded: the pyi false ties removed by ENG-367 (a)", () => {
  // A `.pyi` stub is never imported at runtime — PEP 484 stubs are read by type checkers at
  // analysis time, and CPython's import system only resolves SOURCE_SUFFIXES == ['.py']. So
  // stripping `pyi` could only ever manufacture ties, exactly as the SOURCE_EXTS rule predicts.
  //
  // The trigger is narrower than "the repo has a stubs/ tree": `discarded` is `offendingNew`
  // (run-dispatch.ts:211,245) — files the AGENT authored in this dispatch that are both new and
  // out of commit scope. The blast radius is correspondingly WIDER than the ticket assumed
  // though: `discarded` is dispatch-wide while the rules object is chosen by the CHECK's
  // framework, so a discarded `.pyi` ties to node/ruby/rust/php checks too, not just python.
  //
  // Each pairing avoids the bounded-basename tier by construction — `helper.pyi` appears nowhere
  // in any of these outputs — so the leaf tier is the only route and none can pass for the wrong
  // reason.
  const discarded = ["stubs/helper.pyi"];

  test("intra-language: a discarded stub does not tie to a pytest collection error", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'helper'",
        discarded,
        "pytest",
      ),
    ).toEqual([]);
  });

  test("cross-language: nor to a node check", () => {
    expect(
      importErrorImplicatesDiscarded("Error: Cannot find module './helper'", discarded, "vitest"),
    ).toEqual([]);
  });

  test("cross-language: nor to a ruby check", () => {
    expect(
      importErrorImplicatesDiscarded(
        "LoadError: cannot load such file -- helper",
        discarded,
        "rspec",
      ),
    ).toEqual([]);
  });

  test("cross-language: nor to a rust check", () => {
    expect(
      importErrorImplicatesDiscarded(
        "error[E0432]: unresolved import\nfile not found for module `helper`",
        discarded,
        "cargo",
      ),
    ).toEqual([]);
  });

  test("cross-language: nor to a php check", () => {
    expect(
      importErrorImplicatesDiscarded("Failed opening required 'helper'", discarded, "phpunit"),
    ).toEqual([]);
  });

  test("the discarded-side reduction: a stub is not importable", () => {
    // Under ENG-366 the discarded side is `importableLeaf`, and `pyi` is not in SOURCE_EXTS
    // (ENG-367), so a discarded stub reduces to "" — the tier skips it. This is now the mechanism
    // behind the no-tie end-to-end tests above, independent of how `moduleLeaf` treats a reference.
    expect(importableLeaf("stubs/helper.pyi")).toBe("");
  });

  test("the reduction cannot collide with the stem it used to produce", () => {
    // Separate test, not a trailing assertion: as a trailing assertion it would never be reached
    // under the counterfactual (the first expect aborts), so it could not be shown to bite.
    expect(importableLeaf("stubs/helper.pyi")).not.toBe(moduleLeaf("helper"));
  });

  test("`types.d.pyi` is likewise not importable on the discarded side", () => {
    // Under the old shared `moduleLeaf` this was a LATERAL swap (`d` → `pyi`, one collision-prone
    // leaf for another). `importableLeaf` retires the question on the discarded side entirely: `pyi`
    // is not a source extension, so the reduction is "". (The output side still yields `pyi` — that
    // is the (c) residual, tracked as output-side under ENG-368.)
    expect(importableLeaf("types.d.pyi")).toBe("");
    expect(moduleLeaf("types.d.pyi")).toBe("pyi");
  });
});

describe("importErrorImplicatesDiscarded: removing pyi GAINS (b), ENG-366 then fixes (c)", () => {
  // (b) The gained TRUE tie — the same shape as the `go` case above, and the reason ENG-367 was not
  // merely a narrowing. A python package may hold a submodule named `pyi`. `.pyi` is not in
  // SOURCE_EXTS, so `moduleLeaf("mypkg.pyi")` yields the leaf `pyi`, which meets the discarded
  // `mypkg/pyi.py` (`importableLeaf` → `pyi`). This is an OUTPUT-side gain, so ENG-366 (which only
  // touches the discarded side) leaves it intact — verified below. It is why ENG-367 shipped
  // standalone rather than waiting for this split, which would have left the miss unfixed.
  test("(b) a python submodule named `pyi` ties to the file that defines it (still)", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'mypkg.pyi'",
        ["mypkg/pyi.py"],
        "pytest",
      ),
    ).toEqual(["mypkg/pyi.py"]);
  });

  // (c) FIXED by ENG-366. This was the ENG-367 RESIDUAL — the mirror of the ENG-365 one — pinned as
  // ACCEPTED behavior: under the shared `moduleLeaf`, every discarded `.pyi` reduced to the constant
  // leaf `pyi`, so any captured reference also reducing to `pyi` (e.g. a captured FILE PATH ending
  // `.pyi`, since LEGACY_NAMING's class `([\w./-]+)` accepts `/` and `.`) implicated all of them.
  // ENG-366's `importableLeaf` reduces a discarded `.pyi` path to "" (pyi ∉ SOURCE_EXTS), so the
  // residual is gone. Inverted from the residual assertion these two replace.
  test("(c) FIXED: a captured path ending .pyi no longer implicates unrelated discarded stubs", () => {
    expect(
      importErrorImplicatesDiscarded(
        "could not import stubs/helper.pyi",
        ["other/thing.pyi"],
        "pytest",
      ),
    ).toEqual([]);
  });

  // (c) fixed on EVERY tiesByLeaf framework, not just pytest — `discarded` is dispatch-wide while
  // the rules object follows the check's framework, the same asymmetry the false ties turned on.
  // Was pinned firing on rspec and phpunit; now pinned NOT firing.
  test("(c) FIXED on other frameworks too, not just pytest", () => {
    expect(
      importErrorImplicatesDiscarded(
        "cannot load such file -- stubs/helper.pyi",
        ["other/thing.pyi"],
        "rspec",
      ),
    ).toEqual([]);
    expect(
      importErrorImplicatesDiscarded(
        "Failed opening required 'stubs/helper.pyi'",
        ["other/thing.pyi"],
        "phpunit",
      ),
    ).toEqual([]);
  });

  // (d) The fourth effect, and the one a three-effect draft of this change missed: the output-side
  // reduction ALSO drops ties to stem-named, non-`.pyi` discarded files. `mypkg.pyi` used to
  // reduce to `mypkg` and meet a discarded `src/mypkg.py`; it now reduces to `pyi` and cannot.
  //
  // Benign by CPython's submodule semantics — `No module named 'mypkg.pyi'` is raised only when
  // `mypkg` itself RESOLVED and the submodule did not, so a discarded `mypkg.py` cannot have been
  // the cause and the tie was false. It is an OUTPUT-side removal (via `moduleLeaf`), so — unlike
  // (c) — it survives the ENG-366 discarded-side split untouched, and is pinned to prove it.
  test("(d) a stem-named non-pyi discarded file is no longer implicated", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'mypkg.pyi'",
        ["src/mypkg.py"],
        "pytest",
      ),
    ).toEqual([]);
  });
});

describe("importErrorImplicatesDiscarded: ENG-366 §4.2 — accepted non-importable-extension losses", () => {
  // A discarded `.json`/`.vue` file used to tie via the shared `moduleLeaf`'s constant extension
  // token. ENG-366 reduces it to "" on the discarded side, so the leaf tier no longer fires for it.
  // Sometimes that removes a TRUE tie — accepted (option A) because a constant-token match fires on
  // EVERY discarded file of that extension and is right only by coincidence. Two follow-ups recover
  // the true case principledly: ENG-370 (make naming-only phrases gate tier 4) and ENG-369 (add
  // genuinely-importable extensions like `.vue`).

  test("tier 4 still rescues the true case when the output is an INDICATOR naming the file literally", () => {
    // `Cannot find module` IS an indicator, so the bounded-basename tier is live; `data.json`
    // contains a dot; the bounded regex accepts the `/`-prefixed `'`-suffixed jest form. So the one
    // realistic shape where the discard really is the cause keeps a route to coverage.
    expect(
      importErrorImplicatesDiscarded(
        "Cannot find module './fixtures/data.json' from 'src/a.test.js'",
        ["fixtures/data.json"],
        "jest",
      ),
    ).toEqual(["fixtures/data.json"]);
  });

  test("KNOWN GAP: a naming-ONLY phrase loses the tie to a non-importable-extension discard", () => {
    // `could not import` / `unable to resolve` are naming phrases but NOT indicators, so tier 4 is
    // disabled and the leaf tier was the only route — which ENG-366 removes for a "" reduction. This
    // is the accepted loss, pinned as a known gap (ENG-370 closes the tier-4 half, ENG-369 the
    // list half). `.vue` is source, not a fixture, which is why ENG-369 exists.
    expect(
      importErrorImplicatesDiscarded(
        "could not import ./fixtures/data.json",
        ["fixtures/data.json"],
        "vitest",
      ),
    ).toEqual([]);
    expect(
      importErrorImplicatesDiscarded(
        "could not import ./Button.vue",
        ["src/lib/Button.vue"],
        "vitest",
      ),
    ).toEqual([]);
  });

  test("an extensionless discard no longer ties, and has no tier-4 backstop", () => {
    // `scripts/deploy` reduced to `deploy` under shared `moduleLeaf` and tied to `./deploy`.
    // `importableLeaf` → "" (no extension). base has no dot, so tier 4 never applies either — the
    // deliberate D1 decision: nothing extensionless is importable in a tiesByLeaf ecosystem.
    expect(
      importErrorImplicatesDiscarded(
        "Error: Cannot find module './deploy'",
        ["scripts/deploy"],
        "vitest",
      ),
    ).toEqual([]);
  });
});

describe("importErrorImplicatesDiscarded: ENG-366 §4.3 — the discarded side stays framework-blind", () => {
  // `importableLeaf` asks "can SOME tiesByLeaf language import this path", not "can THIS check's
  // framework" — so a discarded `.rb` still ties to a node check by stem, cross-language. Not fixed
  // here (a future `importableLeaf(path, rules)` would); pinned so the residual is visible.
  test("a discarded ruby file still ties to a node check by stem", () => {
    expect(
      importErrorImplicatesDiscarded(
        "Error: Cannot find module './helper'",
        ["lib/helper.rb"],
        "vitest",
      ),
    ).toEqual(["lib/helper.rb"]);
  });

  // A package-oriented framework (go, jvm) has tiesByLeaf:false, so NEITHER reduction is consulted
  // and ENG-366 cannot change its verdicts. Pinned as the no-op boundary of the change.
  test("a package-oriented framework never reaches the leaf tier, so the split is a no-op for it", () => {
    // `undefined: helper` names a bare symbol; with no `sources` the symbol tier is inert and the
    // leaf tier is off for go, so a discarded `pkg/helper.go` sharing the name is NOT implicated.
    expect(importErrorImplicatesDiscarded("undefined: helper", ["pkg/helper.go"], "go")).toEqual(
      [],
    );
  });
});
