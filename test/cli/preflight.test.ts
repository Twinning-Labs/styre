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

test("collectToolProbes: prepare-bearing probes only prepare; prepare-less probes build/test/check (honors dir, skips unavailable)", () => {
  const profile = makeProfile([
    {
      name: "api",
      kind: "php",
      paths: ["api/**"],
      dir: "api",
      commands: {
        build: "composer build",
        test: "./vendor/bin/phpunit",
        check: { unavailable: true },
      },
      prepare: "composer install",
    },
    {
      name: "svc",
      kind: "go",
      paths: ["svc/**"],
      dir: "svc",
      commands: { build: "go build ./...", test: "go test ./...", check: { unavailable: true } },
    },
  ]);
  expect(collectToolProbes(profile)).toEqual([
    // prepare-bearing php: only the prepare tool (build/test are composer-provided)
    { component: "api", label: "prepare", command: "composer install", cwd: "/repo/api" },
    // prepare-less go: build/test (check unavailable → skipped), cwd honors dir
    { component: "svc", label: "build", command: "go build ./...", cwd: "/repo/svc" },
    { component: "svc", label: "test", command: "go test ./...", cwd: "/repo/svc" },
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

test("preflightToolchain: aggregates missing tools (prepare-less build/test + prepare-bearing prepare)", () => {
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
  ]);
});

test("preflightToolchain: a prepare-provided test tool is NOT probed (php clean checkout)", () => {
  // php's ./vendor/bin/phpunit is created by `composer install` and absent on a clean checkout.
  // The preflight must probe only `composer` (present) and NOT the not-yet-installed test tool —
  // otherwise it false-fails the exact clean-checkout/CI case it exists for.
  const profile = makeProfile([
    {
      name: "php",
      kind: "php",
      paths: ["**"],
      commands: { build: "true", test: "./vendor/bin/phpunit", check: { unavailable: true } },
      prepare: "composer install",
    },
  ]);
  expect(preflightToolchain(profile, fakeProbe(["composer"]))).toEqual([]);
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
