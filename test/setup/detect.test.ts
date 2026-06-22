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
