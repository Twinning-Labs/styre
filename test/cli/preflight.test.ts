import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MissingCommand,
  collectToolProbes,
  formatMissingTools,
  missingHint,
  preflightToolchain,
} from "../../src/cli/preflight.ts";
import type { Profile } from "../../src/dispatch/profile.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

function makeProfile(components: Profile["components"], targetRepo = "/repo"): Profile {
  return parseProfile({ slug: "test", targetRepo, components });
}

// A fake probe: the leading token of `command` is "present" iff it's in the allow-list.
function fakeProbe(present: string[]): (repoDir: string, command: string) => boolean {
  const set = new Set(present);
  return (_repoDir, command) => set.has(command.trim().split(/\s+/)[0]);
}

test("collectToolProbes: prepare + build/test/check, honors dir, skips unavailable", () => {
  const profile = makeProfile([
    {
      name: "api",
      kind: "php",
      paths: ["api/**"],
      dir: "api",
      commands: { build: "composer build", test: "phpunit", check: { unavailable: true } },
      prepare: "composer install",
    },
  ]);
  expect(collectToolProbes(profile)).toEqual([
    { component: "api", label: "prepare", command: "composer install", cwd: "/repo/api" },
    { component: "api", label: "build", command: "composer build", cwd: "/repo/api" },
    { component: "api", label: "test", command: "phpunit", cwd: "/repo/api" },
  ]);
});

test("preflightToolchain: all tools present → no missing", () => {
  const profile = makeProfile([
    {
      name: "api",
      kind: "php",
      paths: ["**"],
      commands: { build: "composer build", test: "phpunit", check: "phpstan" },
      prepare: "composer install",
    },
  ]);
  expect(preflightToolchain(profile, fakeProbe(["composer", "phpunit", "phpstan"]))).toEqual([]);
});

test("preflightToolchain: a missing program is reported with component/label/command", () => {
  const profile = makeProfile([
    {
      name: "api",
      kind: "php",
      paths: ["**"],
      commands: { build: "true", test: "true", check: "true" },
      prepare: "composer install",
    },
  ]);
  expect(preflightToolchain(profile, fakeProbe(["true"]))).toEqual([
    { component: "api", label: "prepare", command: "composer install", missing: "composer" },
  ]);
});

test("preflightToolchain: aggregates every missing tool across components (incl. go/jvm, no prepare)", () => {
  const profile = makeProfile([
    {
      name: "go",
      kind: "go",
      paths: ["**"],
      commands: { build: "go build ./...", test: "go test ./...", check: { unavailable: true } },
    },
    {
      name: "web",
      kind: "node",
      paths: ["web/**"],
      dir: "web",
      commands: { build: "npm run build", test: "npm run test", check: { unavailable: true } },
      prepare: "pnpm install",
    },
  ]);
  const missing = preflightToolchain(profile, fakeProbe([])); // nothing present
  expect(missing.map((m) => `${m.component}/${m.label}:${m.missing}`)).toEqual([
    "go/build:go",
    "go/test:go",
    "web/prepare:pnpm",
    'web/build:npm script "build"',
    'web/test:npm script "test"',
  ]);
});

test("missingHint: npm run → the script; otherwise the leading program", () => {
  expect(missingHint("npm run build")).toBe('npm script "build"');
  expect(missingHint("  composer install ")).toBe("composer");
  expect(missingHint("go build ./...")).toBe("go");
});

test("formatMissingTools: names command, component/label, and missing program", () => {
  const missing: MissingCommand[] = [
    { component: "api", label: "prepare", command: "composer install", missing: "composer" },
  ];
  const msg = formatMissingTools(missing);
  expect(msg).toContain("cannot start");
  expect(msg).toContain("[api / prepare]");
  expect(msg).toContain("composer install");
  expect(msg).toContain("(missing: composer)");
  expect(msg).toContain("Install the missing tool(s) and re-run.");
});

test("preflightToolchain (real probe): catches an absent binary, passes a present one", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-preflight-repo-"));
  const profile = makeProfile(
    [
      {
        name: "x",
        kind: "custom",
        paths: ["**"],
        commands: {
          build: "styre-definitely-absent-xyz build",
          test: "sh -c true",
          check: { unavailable: true },
        },
      },
    ],
    repo,
  );
  const missing = preflightToolchain(profile); // real probeCommandExists
  rmSync(repo, { recursive: true, force: true });
  const labels = missing.map((m) => `${m.label}:${m.missing}`);
  expect(labels).toContain("build:styre-definitely-absent-xyz");
  expect(labels).not.toContain("test:sh"); // `sh` is present
});
