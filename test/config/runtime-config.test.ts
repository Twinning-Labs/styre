import { expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG, RuntimeConfigSchema } from "../../src/config/runtime-config.ts";

test("complexityGrading defaults to false", () => {
  expect(DEFAULT_RUNTIME_CONFIG.complexityGrading).toBe(false);
  expect(RuntimeConfigSchema.parse({}).complexityGrading).toBe(false);
});

test("complexityGrading can be enabled", () => {
  expect(RuntimeConfigSchema.parse({ complexityGrading: true }).complexityGrading).toBe(true);
});

test("parses an optional jira block (statusMap + bugTypeNames)", () => {
  const cfg = RuntimeConfigSchema.parse({
    issueTracker: "jira",
    jira: {
      statusMap: { done: { status: "Done", resolution: "Fixed" } },
      bugTypeNames: ["Bug", "Defect"],
    },
  });
  expect(cfg.jira?.statusMap?.done).toEqual({ status: "Done", resolution: "Fixed" });
  expect(cfg.jira?.bugTypeNames).toEqual(["Bug", "Defect"]);
});

test("jira block is optional (absent -> undefined)", () => {
  expect(RuntimeConfigSchema.parse({}).jira).toBeUndefined();
});

test("implementDisposition defaults to reject", () => {
  expect(DEFAULT_RUNTIME_CONFIG.implementDisposition).toBe("reject");
});

test("implementDisposition accepts discard", () => {
  expect(RuntimeConfigSchema.parse({ implementDisposition: "discard" }).implementDisposition).toBe(
    "discard",
  );
});
