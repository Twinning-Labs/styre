// test/release/stamp-version.test.ts
import { expect, test } from "bun:test";
import { stampVersion } from "../../scripts/stamp-version.ts";

const SAMPLE = `{\n  "name": "styre",\n  "version": "0.0.0",\n  "type": "module"\n}\n`;

test("stampVersion replaces the version and keeps formatting", () => {
  const out = stampVersion(SAMPLE, "0.1.0");
  expect(out).toContain(`"version": "0.1.0"`);
  expect(out).not.toContain(`"0.0.0"`);
  expect(out.endsWith("}\n")).toBe(true);
});

test("stampVersion strips a leading v", () => {
  expect(stampVersion(SAMPLE, "v2.0.0")).toContain(`"version": "2.0.0"`);
});
