import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noPrimaryLeft } from "../../src/cli/component-roles.ts";
import { loadRunProfile } from "../../src/cli/load-profile.ts";

/**
 * BEHAVIOURAL tests for ENG-435. The previous branch shipped only grep-over-source guards, and
 * an independent review pointed out that nothing exercised the three behaviours actually being
 * claimed. These do.
 */
function profileFile(components: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-lp-"));
  const p = join(dir, "profile.json");
  writeFileSync(p, JSON.stringify({ schemaVersion: 4, slug: "demo", targetRepo: dir, components }));
  return p;
}

const REAL = {
  name: "python",
  kind: "python",
  paths: ["**"],
  commands: { build: "make", test: "pytest", check: "ruff" },
  extensions: [".py"],
};
const FIXTURE = {
  name: "tests-roots-test-theming",
  kind: "python",
  role: "fixture",
  dir: "tests/roots/test-theming",
  paths: ["tests/roots/test-theming/**"],
  // NOTE: no resolved commands at all. sphinx's fixture projects are like this.
  commands: {},
  extensions: [".py"],
};

test("the loaded profile is ALREADY narrowed — a fixture never reaches the caller", () => {
  const { profile, nonPrimary } = loadRunProfile({ profile: profileFile([REAL, FIXTURE]) });
  expect(profile.components.map((c) => c.name)).toEqual(["python"]);
  expect(nonPrimary.map((n) => n.component)).toEqual(["tests-roots-test-theming"]);
});

test("a fixture with NO resolved commands does not reach assertResolved", () => {
  // THE SPHINX CASE. `assertResolved` throws on an undefined build/test/check, and it used to
  // see fixture components because narrowing happened after it. The fixture above has `{}` for
  // commands, so if it survived the load this would be non-empty and the run would refuse to
  // start over a component it will never touch.
  const { profile } = loadRunProfile({ profile: profileFile([REAL, FIXTURE]) });
  const unresolved = profile.components.filter((c) =>
    (["build", "test", "check"] as const).some((k) => c.commands[k] === undefined),
  );
  expect(unresolved).toEqual([]);
});

test("an absent role still means primary — a pre-ENG-425 profile is untouched", () => {
  const noRole = { ...REAL, role: undefined };
  const { profile, nonPrimary } = loadRunProfile({ profile: profileFile([noRole]) });
  expect(profile.components).toHaveLength(1);
  expect(nonPrimary).toEqual([]);
});

test("the returned profile is always a NEW object, whether or not anything was dropped", () => {
  // Returning the loaded object in one branch and a copy in the other would make identity depend
  // on repo content, so a later `profile.targetRepo = …` would mutate the caller's object on
  // some repos and a copy on others.
  const a = loadRunProfile({ profile: profileFile([REAL]) });
  const b = loadRunProfile({ profile: profileFile([REAL, FIXTURE]) });
  a.profile.targetRepo = "/mutated";
  b.profile.targetRepo = "/mutated";
  expect(a.profile.targetRepo).toBe("/mutated");
  expect(b.profile.targetRepo).toBe("/mutated");
});

test("noPrimaryLeft is true only when classification emptied the run", () => {
  const emptied = loadRunProfile({ profile: profileFile([FIXTURE]) });
  expect(noPrimaryLeft(emptied)).toBe(true);
  const fine = loadRunProfile({ profile: profileFile([REAL, FIXTURE]) });
  expect(noPrimaryLeft(fine)).toBe(false);
});

test("loading does NOT throw when everything is non-primary", () => {
  // The fatal is the CALLER's decision, on the fresh path only: `--resume`/`--inspect` must not
  // gain a new way to exit 69, and `--inspect` must stay a read-only diagnostic that exits 0.
  expect(() => loadRunProfile({ profile: profileFile([FIXTURE]) })).not.toThrow();
});
