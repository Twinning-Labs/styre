import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StyreError } from "../../src/cli/errors.ts";
import { discoverRuntimeConfig } from "../../src/config/discover.ts";

function cfg(obj: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), "styre-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(obj));
  discoverRuntimeConfig({ explicitPath: path });
}

test("an unknown issueTracker throws a ConfigError listing valid values", () => {
  try {
    cfg({ issueTracker: "liner" });
    throw new Error("expected a throw");
  } catch (e) {
    expect(e).toBeInstanceOf(StyreError);
    expect((e as StyreError).code).toBe(78);
    expect((e as StyreError).detail ?? (e as StyreError).headline).toContain("linear");
  }
});

test("notifier 'none' is accepted (sentinel, not an adapter)", () => {
  expect(() => cfg({ notifier: "none" })).not.toThrow();
});
