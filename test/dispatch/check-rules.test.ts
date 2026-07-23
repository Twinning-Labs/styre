import { describe, expect, test } from "bun:test";
import { moduleLeaf } from "../../src/dispatch/check-rules.ts";
import { importErrorImplicatesDiscarded } from "../../src/dispatch/check-selector.ts";

// `moduleLeaf` reduces a path or module reference to its leaf identifier. It feeds the leaf tier
// of the discard-poison guard (`importErrorImplicatesDiscarded`), which asks whether a red check
// failed BECAUSE this dispatch discarded a file the check imports. Both sides of that comparison
// go through `moduleLeaf`: the discarded path, and the module reference parsed out of the runner's
// output. So an extension added here changes ties on BOTH sides — usually making them more likely,
// but not always in the same direction: ENG-365 showed that adding `go` also DESTROYS a tie, by
// popping `.go` off a real python reference `mypkg.go` so it can no longer meet `mypkg/go.py`.
// Neither adding nor removing an entry is a one-directional change; reason about both sides.

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

  // NOT `toBe(moduleLeaf(other))` — without the fix both sides reduce to "svelte" and such an
  // assertion passes vacuously. Pin the concrete leaf on each side instead.
  test("both sides of the guard's pairing reduce to the same concrete leaf", () => {
    expect(moduleLeaf("./Button.svelte")).toBe("button"); // output side
    expect(moduleLeaf("src/lib/Button.svelte")).toBe("button"); // discarded-path side
  });
});

describe("moduleLeaf: extensions deliberately NOT stripped", () => {
  // Build manifests. Nothing imports them, so stripping could only ever produce a FALSE tie —
  // and their stems are among the most collision-prone tokens in a repo.
  test("a build manifest keeps its extension as the leaf", () => {
    expect(moduleLeaf("infra/build.gradle")).toBe("gradle");
    expect(moduleLeaf("tasks.rake")).toBe("rake");
    expect(moduleLeaf("styre.gemspec")).toBe("gemspec");
  });

  test("no collision with the tokens those stems would have produced", () => {
    // If `.gradle` were stripped, this would be `build` — matching a node check that fails on
    // `Cannot find module '../build'`, implicating an unrelated discarded file.
    expect(moduleLeaf("infra/build.gradle")).not.toBe(moduleLeaf("../build"));
    // If `.gemspec` were stripped, this would be `styre` — matching a genuinely-missing
    // `lib/styre.rb`, so the retry message would name the wrong culprit.
    expect(moduleLeaf("styre.gemspec")).not.toBe(moduleLeaf("lib/styre.rb"));
  });

  // JVM source extensions: `jvmRules.tiesByLeaf` is false, so JVM checks never reach the leaf
  // tier and adding these would buy nothing while widening cross-language tie opportunities.
  test("JVM-only source extensions are left alone", () => {
    expect(moduleLeaf("Main.kts")).toBe("kts");
    expect(moduleLeaf("FooSpec.groovy")).toBe("groovy");
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

describe("moduleLeaf: go/JVM source extensions are NOT stripped (ENG-365)", () => {
  // These four were grandfathered in, failing the rule in SOURCE_EXTS's doc comment: their
  // languages are tiesByLeaf:false, so no check that CAN import them ever reaches the leaf tier,
  // while every tiesByLeaf language that does reach it can only tie to them falsely. They now sit
  // beside kts/groovy — excluded on identical reasoning. The end-to-end consequence is pinned in
  // "the false ties removed by ENG-365" below; these assert the reduction itself.
  test("the extension survives as the leaf", () => {
    expect(moduleLeaf("cmd/build.go")).toBe("go");
    expect(moduleLeaf("src/Build.java")).toBe("java");
    expect(moduleLeaf("jvm/util.kt")).toBe("kt");
    expect(moduleLeaf("jvm/Helper.scala")).toBe("scala");
  });

  test("no collision with the tokens those stems would have produced", () => {
    // The shape of the false tie: stripped, `cmd/build.go` reduces to `build` and meets a node
    // check failing on `Cannot find module '../build'`. Unstripped, the two cannot meet.
    expect(moduleLeaf("cmd/build.go")).not.toBe(moduleLeaf("../build"));
    expect(moduleLeaf("jvm/util.kt")).not.toBe(moduleLeaf("util"));
  });
});

describe("moduleLeaf: non-source extensions", () => {
  test("keeps a data/config extension as the leaf", () => {
    expect(moduleLeaf("config.yaml")).toBe("yaml");
    expect(moduleLeaf("data.json")).toBe("json");
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

  // The other direction: stripping was WRONG on the OUTPUT side too. A python package may
  // legitimately hold a submodule named `go`. Stripping popped `.go` off `mypkg.go` as though it
  // were a file extension, yielding the leaf `mypkg`, while the discarded `mypkg/go.py` yields
  // `go` — so a GENUINELY poisoned check went untied and was persisted as covering its criterion.
  // Removal makes the two meet. NOT a clean win, though — see the residual pinned below.
  test("a python submodule named `go` now ties to the file that defines it", () => {
    expect(
      importErrorImplicatesDiscarded(
        "ModuleNotFoundError: No module named 'mypkg.go'",
        ["mypkg/go.py"],
        "pytest",
      ),
    ).toEqual(["mypkg/go.py"]);
  });

  // RESIDUAL, pinned so it is visible rather than discovered later. Removal is NOT
  // one-directional: every discarded `.go` file now reduces to the constant leaf `go`, so the very
  // output shape that unlocks the true tie above also implicates unrelated Go files — and fires
  // with no true tie present at all. Accepted because it is strictly narrower than what it
  // replaces: stripped, the discarded side collapsed to generic STEMS (`build`, `server`) that
  // collide with any python/node error naming a common module; unstripped it collides only when
  // the output names a reference literally ending in `.go`. Consequence is a spurious retry, never
  // a wrong verdict. Asserted as CURRENT behavior, not as endorsement — the fix (stop sharing
  // `moduleLeaf` between the output and discarded sides) is a separate ticket.
  test("RESIDUAL: that same output also implicates unrelated discarded Go files", () => {
    const out = "ModuleNotFoundError: No module named 'mypkg.go'";
    // Alongside the true tie.
    expect(importErrorImplicatesDiscarded(out, ["mypkg/go.py", "cmd/build.go"], "pytest")).toEqual([
      "mypkg/go.py",
      "cmd/build.go",
    ]);
    // And with no true tie present at all.
    expect(importErrorImplicatesDiscarded(out, ["cmd/build.go"], "pytest")).toEqual([
      "cmd/build.go",
    ]);
  });
});
