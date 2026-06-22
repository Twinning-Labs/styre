import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../../src/config/runtime-config.ts";

test("complexityGrading defaults to false", () => {
  expect(DEFAULT_RUNTIME_CONFIG.complexityGrading).toBe(false);
  expect(RuntimeConfigSchema.parse({}).complexityGrading).toBe(false);
});

test("complexityGrading can be enabled", () => {
  expect(RuntimeConfigSchema.parse({ complexityGrading: true }).complexityGrading).toBe(true);
});
