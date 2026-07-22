import { describe, expect, test } from "bun:test";
import { moduleLeaf } from "../../src/dispatch/check-rules.ts";
import { importErrorImplicatesDiscarded } from "../../src/dispatch/check-selector.ts";

// `moduleLeaf` reduces a path or module reference to its leaf identifier. It feeds the leaf tier
// of the discard-poison guard (`importErrorImplicatesDiscarded`), which asks whether a red check
// failed BECAUSE this dispatch discarded a file the check imports. Both sides of that comparison
// go through `moduleLeaf`: the discarded path, and the module reference parsed out of the runner's
// output. So an extension added here makes ties MORE likely on both sides.

describe("moduleLeaf: extensions already handled", () => {
  test("reduces a path to its module leaf", () => {
    expect(moduleLeaf("checks/helper.py")).toBe("helper");
    expect(moduleLeaf("./a/helper.js")).toBe("helper");
    expect(moduleLeaf("src/main.rs")).toBe("main");
    expect(moduleLeaf("Foo.java")).toBe("foo");
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

describe("moduleLeaf: grandfathered entries that fail the current scope rule", () => {
  // go/java/kt/scala predate the rule in SOURCE_EXTS's doc comment: their languages are
  // tiesByLeaf:false, so no check that can import them reaches the leaf tier — yet they are
  // stripped, so they can only produce false ties. Pinned as CURRENT behavior, not as endorsement.
  test("they are still stripped", () => {
    expect(moduleLeaf("cmd/build.go")).toBe("build");
    expect(moduleLeaf("src/Build.java")).toBe("build");
    expect(moduleLeaf("jvm/util.kt")).toBe("util");
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
