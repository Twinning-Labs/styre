import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCommandExists } from "../../src/setup/discover-schema.ts";

function repo(opts: { scripts?: Record<string, string>; localBins?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "styre-probe-"));
  if (opts.scripts) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: opts.scripts }));
  }
  for (const spec of opts.localBins ?? []) {
    const full = join(dir, spec);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "#!/bin/sh\n", { mode: 0o755 });
  }
  return dir;
}

describe("ENG-414: a repo's own tooling is not on PATH", () => {
  test("a binary in node_modules/.bin resolves", () => {
    // `tsc --noEmit`, `jest`, `eslint` were all REJECTED before this — `command -v` never sees
    // node_modules/.bin, so styre lost gates the repo genuinely supports.
    const dir = repo({ localBins: ["node_modules/.bin/tsc"] });
    expect(probeCommandExists(dir, "tsc --noEmit")).toBe(true);
  });

  test("a binary in a virtualenv resolves", () => {
    const dir = repo({ localBins: [".venv/bin/pytest"] });
    expect(probeCommandExists(dir, "pytest -q")).toBe(true);
  });

  test("a genuinely absent binary is still rejected", () => {
    expect(probeCommandExists(repo(), "definitely-not-a-real-binary-xyz --lint")).toBe(false);
  });

  test("a binary on PATH still resolves", () => {
    expect(probeCommandExists(repo(), "sh -c true")).toBe(true);
  });
});

describe("ENG-414: a script invocation is checked against the script list", () => {
  test("every manager's `run` form is checked, not just npm's", () => {
    // `pnpm run lint` used to be accepted whenever pnpm existed, script or not.
    const dir = repo({ scripts: { lint: "eslint ." } });
    for (const mgr of ["npm", "pnpm", "yarn", "bun"]) {
      expect(probeCommandExists(dir, `${mgr} run lint`)).toBe(true);
      expect(probeCommandExists(dir, `${mgr} run nonexistent`)).toBe(false);
    }
  });

  test("the bare shorthand is a script for pnpm and yarn", () => {
    const dir = repo({ scripts: { lint: "eslint ." } });
    expect(probeCommandExists(dir, "pnpm lint")).toBe(true);
    expect(probeCommandExists(dir, "yarn lint")).toBe(true);
    expect(probeCommandExists(dir, "pnpm typo")).toBe(false);
    expect(probeCommandExists(dir, "yarn typo")).toBe(false);
  });

  test("npm's script aliases map onto same-named scripts", () => {
    const withTest = repo({ scripts: { test: "jest" } });
    expect(probeCommandExists(withTest, "npm test")).toBe(true);
    expect(probeCommandExists(repo({ scripts: {} }), "npm test")).toBe(false);
  });

  function managerInstalled(mgr: string): boolean {
    return Bun.spawnSync(["sh", "-c", 'command -v "$1"', "sh", mgr]).success;
  }

  test("a manager's OWN subcommand is checked as a binary, not against the script list", () => {
    // `npm ci` / `pnpm install` are valid with no matching script; requiring one would reject
    // every prepare command in the corpus. What they DO require is the manager itself, so the
    // expectation follows whether it is installed here rather than assuming it is.
    const dir = repo({ scripts: {} });
    for (const [mgr, cmd] of [
      ["npm", "npm ci"],
      ["npm", "npm install"],
      ["pnpm", "pnpm install"],
      ["yarn", "yarn install"],
      ["bun", "bun install"],
    ] as const) {
      expect(probeCommandExists(dir, cmd)).toBe(managerInstalled(mgr));
    }
  });

  test("`bun test` is bun's own runner, not a missing script", () => {
    // With no "test" script present, treating this as a script would reject it wrongly.
    expect(probeCommandExists(repo({ scripts: {} }), "bun test")).toBe(managerInstalled("bun"));
  });

  test("a script invocation against a repo with no package.json is rejected", () => {
    expect(probeCommandExists(repo(), "npm run build")).toBe(false);
  });

  test("a malformed package.json rejects rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "styre-probe-bad-"));
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(probeCommandExists(dir, "npm run build")).toBe(false);
  });

  test("an empty command is rejected", () => {
    expect(probeCommandExists(repo(), "   ")).toBe(false);
  });
});
