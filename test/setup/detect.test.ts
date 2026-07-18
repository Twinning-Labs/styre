import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectChecksSystem,
  detectCommands,
  detectPackageManager,
} from "../../src/setup/detect.ts";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "styre-detect-"));
}

test("detectPackageManager reads the lockfile, defaults npm", () => {
  const a = tmpRepo();
  writeFileSync(join(a, "bun.lock"), "");
  expect(detectPackageManager(a)).toBe("bun");
  const b = tmpRepo();
  writeFileSync(join(b, "pnpm-lock.yaml"), "");
  expect(detectPackageManager(b)).toBe("pnpm");
  const c = tmpRepo(); // no lockfile
  expect(detectPackageManager(c)).toBe("npm");
});

test("detectCommands maps known scripts to '<pm> run <name>'", () => {
  const repo = tmpRepo();
  writeFileSync(join(repo, "bun.lock"), "");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { test: "vitest", build: "tsc", deploy: "x" } }),
  );
  const cmds = detectCommands(repo);
  expect(cmds.test).toBe("bun run test");
  expect(cmds.build).toBe("bun run build");
  expect(cmds.deploy).toBeUndefined(); // only test/build/lint/typecheck are mapped
});

test("detectCommands returns {} when there is no package.json", () => {
  expect(detectCommands(tmpRepo())).toEqual({});
});

test("detectChecksSystem detects github workflows, else none", () => {
  const gh = tmpRepo();
  mkdirSync(join(gh, ".github", "workflows"), { recursive: true });
  writeFileSync(join(gh, ".github", "workflows", "ci.yml"), "on: push");
  expect(detectChecksSystem(gh)).toBe("github");
  expect(detectChecksSystem(tmpRepo())).toBe("none");
});

// ---------------------------------------------------------------------------
// ENG-340 #3 -- the probe must parse `on:`. A workflow that never triggers on a
// PR head can never report a check-run there, so probing it as "github" makes
// every ticket on that repo wait out the full checks budget and then escalate,
// forever, with a true-but-useless reason.
// ---------------------------------------------------------------------------

function repoWithWorkflows(files: Record<string, string>): string {
  const dir = tmpRepo();
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, ".github", "workflows", name), body);
  }
  return dir;
}

test("detectChecksSystem: a release-only workflow is not a checks system", () => {
  expect(detectChecksSystem(repoWithWorkflows({ "release.yml": "on: release\njobs: {}\n" }))).toBe(
    "none",
  );
});

test("detectChecksSystem: schedule- and dispatch-only workflows are not a checks system", () => {
  expect(
    detectChecksSystem(
      repoWithWorkflows({
        "stale.yml": "on:\n  schedule:\n    - cron: '0 0 * * *'\n",
        "deploy.yml": "on: workflow_dispatch\n",
      }),
    ),
  ).toBe("none");
});

test("detectChecksSystem: recognises pull_request in every YAML trigger shape", () => {
  // scalar
  expect(detectChecksSystem(repoWithWorkflows({ "a.yml": "on: pull_request\n" }))).toBe("github");
  // sequence
  expect(detectChecksSystem(repoWithWorkflows({ "b.yml": "on: [push, pull_request]\n" }))).toBe(
    "github",
  );
  // mapping with filters
  expect(
    detectChecksSystem(
      repoWithWorkflows({ "c.yml": "on:\n  pull_request:\n    branches: [main]\n" }),
    ),
  ).toBe("github");
  // pull_request_target
  expect(detectChecksSystem(repoWithWorkflows({ "d.yml": "on: pull_request_target\n" }))).toBe(
    "github",
  );
});

test("detectChecksSystem: one PR-triggered workflow among release-only ones is enough", () => {
  expect(
    detectChecksSystem(
      repoWithWorkflows({
        "release.yml": "on: release\n",
        "ci.yml": "on:\n  pull_request:\n",
      }),
    ),
  ).toBe("github");
});

test("detectChecksSystem: .yaml is honoured as well as .yml", () => {
  expect(detectChecksSystem(repoWithWorkflows({ "ci.yaml": "on: pull_request\n" }))).toBe("github");
});

test("detectChecksSystem: an unparseable workflow fails SAFE (assume checks exist)", () => {
  // Guessing "none" would silently skip CI verification and call a PR pr-ready
  // with no ground truth at all. Waiting is merely annoying; that is worse.
  expect(detectChecksSystem(repoWithWorkflows({ "ci.yml": "this: [is: not: valid: yaml\n" }))).toBe(
    "github",
  );
});

test("detectChecksSystem: 'on' is not swallowed by the YAML 1.1 boolean gotcha", () => {
  // In YAML 1.1, the bare key `on` parses as boolean true -- a classic Actions
  // footgun. If that ever regresses, this workflow reads as having no triggers.
  expect(
    detectChecksSystem(repoWithWorkflows({ "ci.yml": "on:\n  push:\n    branches: [main]\n" })),
  ).toBe("github");
});

test("detectChecksSystem: a workflows dir with no workflow files is none", () => {
  expect(detectChecksSystem(repoWithWorkflows({ "README.md": "not a workflow\n" }))).toBe("none");
});
