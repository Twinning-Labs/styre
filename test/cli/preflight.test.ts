import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolchainError } from "../../src/cli/errors.ts";
import { renderError } from "../../src/cli/output.ts";
import {
  type MissingCommand,
  applyToolchainGate,
  collectToolProbes,
  formatMissingTools,
  formatUnusableComponents,
  missingHint,
  partitionByToolchain,
  preflightToolchain,
} from "../../src/cli/preflight.ts";
import type { Profile } from "../../src/dispatch/profile.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";

// Fixtures may omit `extensions` (ComponentSchema defaults it to []); parseProfile fills it. The
// inferred `Profile["components"]` type requires it, so accept the pre-default shape here.
type ComponentInput = Omit<Profile["components"][number], "extensions"> & { extensions?: string[] };

function makeProfile(components: ComponentInput[], targetRepo = "/repo"): Profile {
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

test("formatMissingTools: names command, component/label, and missing program — body only, no headline/recovery", () => {
  const missing: MissingCommand[] = [
    { component: "api", label: "prepare", command: "composer install", missing: "composer" },
  ];
  const msg = formatMissingTools(missing);
  expect(msg).toContain("[api / prepare]");
  expect(msg).toContain("composer install");
  expect(msg).toContain("(missing: composer)");
  // The headline and recovery hint now live solely in `toolchainError` — formatMissingTools
  // must not duplicate them, or the framed message doubles the headline.
  expect(msg).not.toContain("cannot start");
  expect(msg).not.toContain("Install the missing tool(s) and re-run.");
});

test("formatMissingTools + toolchainError: framed message has exactly one headline, one recovery line", () => {
  const missing: MissingCommand[] = [
    { component: "api", label: "prepare", command: "composer install", missing: "composer" },
  ];
  const rendered = renderError("run", toolchainError(formatMissingTools(missing)));
  expect(rendered).toContain("cannot start — required commands are not runnable on this machine");
  expect(rendered).toContain("[api / prepare]");
  expect(rendered).toContain("Install the missing tool(s) and re-run.");
  expect(rendered.split("cannot start").length - 1).toBe(1);
  expect(rendered.split("Install the missing tool(s) and re-run.").length - 1).toBe(1);
});

test("preflightToolchain (real probe): catches an absent binary, passes a present one", () => {
  const repo = mkdtempSync(join(tmpdir(), "styre-preflight-repo-"));
  const profile = makeProfile(
    [
      {
        name: "x",
        kind: "node",
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

// -- ENG-412: a missing toolchain disqualifies its component, not the whole run ---------------

/** django's real shape: a Python repo that also ships a `package.json` for linting its admin JS. */
function djangoShapedProfile(): Profile {
  return makeProfile([
    {
      name: "python",
      kind: "python",
      paths: ["django/**"],
      commands: { test: "tox" },
      prepare: "pip install -e .",
    },
    {
      name: "frontend",
      kind: "node",
      paths: ["js_tests/**"],
      commands: {},
      prepare: "npm install",
    },
  ]);
}

test("partitionByToolchain: a Python repo carrying a package.json is NOT fatal — it runs without the frontend", () => {
  const p = partitionByToolchain(djangoShapedProfile(), fakeProbe(["pip"]));

  expect(p.fatal).toBe(false);
  expect(p.unusable.map((u) => u.component)).toEqual(["frontend"]);
  expect(p.usable.map((c) => c.name)).toEqual(["python"]);
  // The reason survives, so the caller can say WHY it skipped, not merely that it did.
  expect(p.unusable[0]?.missing[0]?.missing).toBe("npm");
});

test("partitionByToolchain: a single-component repo whose one toolchain is absent is STILL fatal (ENG-332 preserved)", () => {
  const profile = makeProfile([
    { name: "web", kind: "node", paths: ["src/**"], commands: {}, prepare: "npm install" },
  ]);
  const p = partitionByToolchain(profile, fakeProbe([]));

  expect(p.fatal).toBe(true);
  expect(p.usable).toEqual([]);
  expect(p.missing).toHaveLength(1);
});

test("partitionByToolchain: EVERY component broken is fatal even when there are several", () => {
  const p = partitionByToolchain(djangoShapedProfile(), fakeProbe([]));

  expect(p.fatal).toBe(true);
  expect(p.unusable.map((u) => u.component).sort()).toEqual(["frontend", "python"]);
});

test("partitionByToolchain: nothing missing is never fatal and skips nothing", () => {
  const p = partitionByToolchain(djangoShapedProfile(), fakeProbe(["pip", "npm"]));

  expect(p.fatal).toBe(false);
  expect(p.unusable).toEqual([]);
  expect(p.usable).toHaveLength(2);
});

test("partitionByToolchain: a component with NO probes at all is usable — its tooling is not in question", () => {
  const profile = makeProfile([
    { name: "docs", kind: "node", paths: ["docs/**"], commands: {} },
    { name: "web", kind: "node", paths: ["src/**"], commands: {}, prepare: "npm install" },
  ]);
  const p = partitionByToolchain(profile, fakeProbe([]));

  // `web` is broken, but `docs` survives, so the run can still do something.
  expect(p.fatal).toBe(false);
  expect(p.usable.map((c) => c.name)).toEqual(["docs"]);
});

test("formatUnusableComponents: names the component, the command and the missing program", () => {
  const p = partitionByToolchain(djangoShapedProfile(), fakeProbe(["pip"]));
  const text = formatUnusableComponents(p.unusable);

  expect(text).toContain("frontend");
  expect(text).toContain("npm install");
  expect(text).toContain("missing: npm");
});

test("applyToolchainGate: refuses with exit 69 when NOTHING is usable — ENG-332's behaviour, preserved", () => {
  const profile = makeProfile([
    { name: "web", kind: "node", paths: ["src/**"], commands: {}, prepare: "npm install" },
  ]);
  let code: number | undefined;
  try {
    applyToolchainGate(profile, fakeProbe([]));
  } catch (e) {
    code = (e as { code?: number }).code;
  }
  expect(code).toBe(69);
});

test("applyToolchainGate: narrows the profile instead of refusing when something is usable", () => {
  const original = djangoShapedProfile();
  const gate = applyToolchainGate(original, fakeProbe(["pip"]));

  expect(gate.profile.components.map((c) => c.name)).toEqual(["python"]);
  expect(gate.unusable.map((u) => u.component)).toEqual(["frontend"]);
  // The CALLER's profile is untouched — the narrowing is this run's, on this machine, and must
  // never be mistaken for the project's shape.
  expect(original.components.map((c) => c.name)).toEqual(["python", "frontend"]);
});

test("applyToolchainGate: a fully-equipped repo is returned unchanged, same object identity", () => {
  const profile = djangoShapedProfile();
  const gate = applyToolchainGate(profile, fakeProbe(["pip", "npm"]));

  expect(gate.profile).toBe(profile);
  expect(gate.unusable).toEqual([]);
});
