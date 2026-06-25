import { expect, test } from "bun:test";
import { assertResolved } from "../../src/cli/run.ts";
import type { Profile } from "../../src/dispatch/profile.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

function makeProfile(components: Profile["components"]): Profile {
  return parseProfile({
    slug: "test",
    targetRepo: "/tmp/test",
    components,
  });
}

test("assertResolved throws for a component with an undefined must-have", () => {
  const profile = makeProfile([
    {
      name: "fe",
      kind: "node",
      paths: ["src/**"],
      commands: { build: "npm run build" }, // test and check are absent (undefined)
    },
  ]);
  expect(() => assertResolved(profile)).toThrow(
    /profile component 'fe' has an unresolved 'test' command/,
  );
});

test("assertResolved does not throw when must-haves are { unavailable: true }", () => {
  const profile = makeProfile([
    {
      name: "fe",
      kind: "node",
      paths: ["src/**"],
      commands: {
        build: "npm run build",
        test: { unavailable: true },
        check: { unavailable: true },
      },
    },
  ]);
  expect(() => assertResolved(profile)).not.toThrow();
});

test("assertResolved does not throw when all must-haves are strings", () => {
  const profile = makeProfile([
    {
      name: "api",
      kind: "node",
      paths: ["api/**"],
      commands: {
        build: "tsc",
        test: "jest",
        check: "eslint .",
      },
    },
  ]);
  expect(() => assertResolved(profile)).not.toThrow();
});

test("assertResolved includes the re-run hint in the error message", () => {
  const profile = makeProfile([
    {
      name: "rust",
      kind: "rust",
      paths: ["src/**"],
      commands: { build: "cargo build" }, // missing test + check
    },
  ]);
  expect(() => assertResolved(profile)).toThrow(/re-run `styre setup`/);
});
