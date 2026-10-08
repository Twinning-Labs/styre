import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { StyreError } from "../../src/cli/errors.ts";
import { discoverRuntimeConfig } from "../../src/config/discover.ts";
import { makeTempDir } from "../helpers/temp.ts";

test("a bad config value throws a StyreError naming the file + field, not a ZodError", () => {
  const dir = makeTempDir("styre-cfg-");
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ notifier: "slaack" }));
  try {
    discoverRuntimeConfig({ explicitPath: path });
    throw new Error("expected a throw");
  } catch (e) {
    expect(e).toBeInstanceOf(StyreError);
    const se = e as StyreError;
    expect(se.code).toBe(78);
    expect(se.headline).toContain(path);
    expect(se.headline.toLowerCase()).toContain("notifier");
  }
});
