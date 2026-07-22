import { describe, expect, test } from "bun:test";
import { moduleLeaf } from "../../src/dispatch/check-rules.ts";

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

  test("a discarded .svelte helper now ties to the module the output names", () => {
    // This is the pairing the guard actually performs: output side vs path side.
    expect(moduleLeaf("./Button.svelte")).toBe(moduleLeaf("src/lib/Button.svelte"));
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

describe("moduleLeaf: non-source extensions", () => {
  test("keeps a data/config extension as the leaf", () => {
    expect(moduleLeaf("config.yaml")).toBe("yaml");
    expect(moduleLeaf("data.json")).toBe("json");
  });
});
