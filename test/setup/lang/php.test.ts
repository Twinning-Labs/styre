import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTestFile } from "../../../src/dispatch/test-file.ts";
import { phpDef } from "../../../src/setup/lang/php.ts";
import { resolveCommands } from "../../../src/setup/resolve-commands.ts";

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "styre-php-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

/** Helpers for non-interactive resolveCommands (no prompts). */
function noOpts() {
  return { interactive: false, ask: () => null };
}

test("php: no composer.json → []", () => {
  const root = fixture({ "README.md": "x" });
  expect(phpDef.detect(root)).toHaveLength(0);
});

test("php: composer.json (no pest dep, no tests/Pest.php) → phpunit; every field correct", () => {
  const root = fixture({
    "composer.json": JSON.stringify({ require: { php: "^8.1" } }),
  });
  const components = phpDef.detect(root);
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.name).toBe("php");
  expect(c.kind).toBe("php");
  expect(c.paths).toEqual(["**"]);
  expect(c.commands.test).toBe("./vendor/bin/phpunit");
  expect(c.prepare).toBe("composer install");
  expect(c.testFilePattern).toBe("(^|/)tests?/.*Test\\.php$");
});

test("php: pestphp/pest in require → pest", () => {
  const root = fixture({
    "composer.json": JSON.stringify({ require: { "pestphp/pest": "^2.0" } }),
  });
  const [c] = phpDef.detect(root);
  expect(c.commands.test).toBe("./vendor/bin/pest");
  expect(c.prepare).toBe("composer install");
  expect(c.testFilePattern).toBe("(^|/)tests?/.*Test\\.php$");
  expect(c.kind).toBe("php");
  expect(c.paths).toEqual(["**"]);
});

test("php: pestphp/pest in require-dev → pest", () => {
  const root = fixture({
    "composer.json": JSON.stringify({ "require-dev": { "pestphp/pest": "^2.0" } }),
  });
  const [c] = phpDef.detect(root);
  expect(c.commands.test).toBe("./vendor/bin/pest");
  expect(c.prepare).toBe("composer install");
  expect(c.testFilePattern).toBe("(^|/)tests?/.*Test\\.php$");
  expect(c.kind).toBe("php");
  expect(c.paths).toEqual(["**"]);
});

test("php: tests/Pest.php present (no composer dep) → pest", () => {
  const root = fixture({
    "composer.json": JSON.stringify({ require: { php: "^8.1" } }),
    "tests/Pest.php": "<?php // pest config\n",
  });
  const [c] = phpDef.detect(root);
  expect(c.commands.test).toBe("./vendor/bin/pest");
  expect(c.prepare).toBe("composer install");
  expect(c.testFilePattern).toBe("(^|/)tests?/.*Test\\.php$");
  expect(c.kind).toBe("php");
  expect(c.paths).toEqual(["**"]);
});

test("php: malformed composer.json → still detected, defaults to phpunit", () => {
  const root = fixture({
    "composer.json": "{ this is not valid json !!!",
  });
  const components = phpDef.detect(root);
  // composer.json exists → PHP component is still emitted
  expect(components).toHaveLength(1);
  const [c] = components;
  expect(c.commands.test).toBe("./vendor/bin/phpunit");
  expect(c.prepare).toBe("composer install");
  expect(c.testFilePattern).toBe("(^|/)tests?/.*Test\\.php$");
  expect(c.kind).toBe("php");
  expect(c.paths).toEqual(["**"]);
});

test("php: script-runner warning fires for phpunit (./vendor/bin/phpunit is ./-prefixed)", () => {
  const root = fixture({
    "composer.json": JSON.stringify({ require: { php: "^8.1" } }),
  });
  // promote drafts to Component by attaching extensions (mirrors what runRegistry does)
  const drafts = phpDef.detect(root);
  const components = drafts.map((d) => ({ ...d, extensions: [".php"] }));
  const { warnings } = resolveCommands(components, noOpts());
  // every ./vendor/bin/* command is a script runner — warning must fire
  expect(warnings.some((w) => w.includes("./vendor/bin/phpunit"))).toBe(true);
  expect(warnings.some((w) => w.includes("shell script"))).toBe(true);
});

test("php: script-runner warning fires for pest (./vendor/bin/pest is ./-prefixed)", () => {
  const root = fixture({
    "composer.json": JSON.stringify({ require: { "pestphp/pest": "^2.0" } }),
  });
  // promote drafts to Component by attaching extensions (mirrors what runRegistry does)
  const drafts = phpDef.detect(root);
  const components = drafts.map((d) => ({ ...d, extensions: [".php"] }));
  const { warnings } = resolveCommands(components, noOpts());
  // every ./vendor/bin/* command is a script runner — warning must fire
  expect(warnings.some((w) => w.includes("./vendor/bin/pest"))).toBe(true);
  expect(warnings.some((w) => w.includes("shell script"))).toBe(true);
});

// ─── Durable A1 contract: testFilePattern anchored to tests?/ dir ─────────────

test("php testFilePattern: A1 behavioral gate anchoring contract", () => {
  const root = fixture({
    "composer.json": JSON.stringify({ require: { php: "^8.1" } }),
  });
  const [c] = phpDef.detect(root);
  const pattern = c.testFilePattern ?? "";

  // phpunit discovers these — A1 must credit them
  expect(isTestFile("tests/FooTest.php", pattern)).toBe(true);
  expect(isTestFile("tests/Unit/FooTest.php", pattern)).toBe(true);
  expect(isTestFile("packages/x/test/FooTest.php", pattern)).toBe(true);

  // cardinal-sin guard: co-located test that phpunit never discovers
  // must NOT satisfy A1 — loud failure beats vacuous pass
  expect(isTestFile("src/CalculatorTest.php", pattern)).toBe(false);
});
