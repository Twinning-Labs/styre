import { expect, test } from "bun:test";
import {
  applyRoleGate,
  formatNonPrimaryComponents,
  partitionByRole,
} from "../../src/cli/component-roles.ts";
import type { Profile } from "../../src/dispatch/profile.ts";

/**
 * ENG-425. `pytest-dev__pytest-5631` escalated at tick 1 having done nothing, for $0.25, because
 * the scan turned `extra/setup-py.test` — a py.test name-reservation stub — into a first-class
 * component with `prepare: pip install -e .`, and that install exits 1.
 *
 * The discovery agent had already recognised it: its `label` read "legacy stub package (py.test
 * name reservation, sdist-only, no real tests)". It simply had no field in which to act on that.
 */
type Comp = Profile["components"][number];

function comp(over: Partial<Comp> & { name: string }): Comp {
  return {
    kind: "python",
    paths: [`${over.name}/**`],
    commands: {},
    extensions: [".py"],
    ...over,
  } as Comp;
}

function profileOf(components: Comp[]): Profile {
  return {
    schemaVersion: 4,
    slug: "repo",
    targetRepo: "/repo",
    components,
  } as unknown as Profile;
}

/** The real pytest-5631 shape. */
const REAL = comp({ name: "python", prepare: "pip install tox" });
const DECOY = comp({
  name: "extra-setup-py.test",
  role: "fixture",
  label: "legacy stub package (py.test name reservation, sdist-only, no real tests)",
  prepare: "pip install -e .",
  dir: "extra/setup-py.test",
});

test("a fixture component is excluded from the run; the real one continues", () => {
  const gate = applyRoleGate(profileOf([REAL, DECOY]));
  expect(gate.profile.components.map((c) => c.name)).toEqual(["python"]);
  expect(gate.nonPrimary).toEqual([
    {
      component: "extra-setup-py.test",
      role: "fixture",
      label: "legacy stub package (py.test name reservation, sdist-only, no real tests)",
    },
  ]);
});

test("an ABSENT role means primary — a pre-ENG-425 profile is untouched", () => {
  // The backward-compatibility contract: no schema bump, no migration, no behaviour change for
  // any profile written before this field existed.
  const gate = applyRoleGate(profileOf([comp({ name: "a" }), comp({ name: "b" })]));
  expect(gate.profile.components.map((c) => c.name)).toEqual(["a", "b"]);
  expect(gate.nonPrimary).toEqual([]);
});

test("an explicit primary role is kept", () => {
  const gate = applyRoleGate(profileOf([comp({ name: "a", role: "primary" })]));
  expect(gate.nonPrimary).toEqual([]);
});

test("example and vendored are excluded too, not just fixture", () => {
  const { primary, nonPrimary } = partitionByRole(
    profileOf([
      comp({ name: "app" }),
      comp({ name: "demo", role: "example" }),
      comp({ name: "third_party", role: "vendored" }),
    ]),
  );
  expect(primary.map((c) => c.name)).toEqual(["app"]);
  expect(nonPrimary.map((n) => n.role)).toEqual(["example", "vendored"]);
});

test("EVERY component non-primary → refuse to start (exit 69), never an empty run", () => {
  // A run with nothing left would provision nothing, verify nothing, and reach the evidence
  // floor having measured nothing (ENG-424). Refuse at the door, where the operator can see the
  // classification that caused it. This also fails closed on a discovery agent that misreads a
  // repo and demotes everything.
  let err: unknown;
  try {
    applyRoleGate(profileOf([comp({ name: "demo", role: "example" })]));
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect((err as { code?: number }).code).toBe(69);
  // It must NOT borrow the toolchain headline: nothing is missing from this machine, and saying
  // so would send the operator off installing tools that are already there.
  const headline = (err as { headline?: string }).headline ?? "";
  expect(headline).toContain("not part of the product");
  expect(headline).not.toContain("this machine");
});

test("the narrowing is reported with the agent's own reason", () => {
  const text = formatNonPrimaryComponents([
    { component: "extra-setup-py.test", role: "fixture", label: "legacy stub package" },
  ]);
  expect(text).toContain("extra-setup-py.test");
  expect(text).toContain("fixture");
  expect(text).toContain("legacy stub package");
});

test("a component with no label still reports what and why", () => {
  const text = formatNonPrimaryComponents([{ component: "demo", role: "example" }]);
  expect(text).toContain("demo");
  expect(text).toContain("example");
});
