import { z } from "zod";
import type { TestEnvironmentPlan } from "./environment-schema.ts";

/** Operator policy can restrict capabilities; it cannot invent a runner implementation. */
export const TestPolicySchema = z
  .object({
    suite: z.enum(["required", "advisory"]).optional(),
    authoredChecks: z.literal("disabled").optional(),
  })
  .strict();
export type TestPolicy = z.infer<typeof TestPolicySchema>;

/** The adapter boundary is the only place that translates runner identity into capabilities. */
const declarations = {
  python: { authoredChecks: true, evidence: "process", installScope: "component" },
  node: { authoredChecks: true, evidence: "process", installScope: "workspace" },
  karma: { authoredChecks: false, evidence: "structured", installScope: "workspace" },
  unsupported: { authoredChecks: false, evidence: null, installScope: "component" },
} as const;

export function testCapabilities(plan: TestEnvironmentPlan, policy: TestPolicy = {}) {
  const declaration = Object.hasOwn(declarations, plan.adapter)
    ? declarations[plan.adapter]
    : undefined;
  if (!declaration || plan.adapter === "unsupported")
    return {
      suite: "unsupported",
      authoredChecks: "unsupported",
      evidence: null,
      installScope: "component",
      reason: plan.adapter === "unsupported" ? plan.reason : "Unknown test adapter; rerun setup",
    } as const;
  if (policy.authoredChecks === "disabled" || !declaration.authoredChecks || !("framework" in plan))
    return {
      ...declaration,
      suite: "supported",
      authoredChecks: "unsupported",
      // declaration.authoredChecks is an implementation flag, never the public contract.
      reason:
        policy.authoredChecks === "disabled"
          ? "Authored checks are disabled by test policy"
          : "Existing suite execution is supported; authored-check selection and identity are unsupported",
    } as const;
  return {
    ...declaration,
    suite: "supported",
    authoredChecks: "supported",
    framework: plan.framework,
    launcher: plan.checkLauncher,
  } as const;
}

export function authoredChecksUnavailable(c: {
  testEnvironment?: TestEnvironmentPlan;
  testPolicy?: TestPolicy;
}): string | undefined {
  if (c.testPolicy?.authoredChecks === "disabled")
    return "Authored checks are disabled by test policy";
  if (!c.testEnvironment) return;
  const capability = testCapabilities(c.testEnvironment, c.testPolicy);
  return capability.authoredChecks === "unsupported" ? capability.reason : undefined;
}

/** Preserve legacy advisory suites; suite-only plans default to required regardless of runner. */
export function suiteRequirement(c: {
  testEnvironment?: TestEnvironmentPlan;
  testPolicy?: TestPolicy;
}): "required" | "advisory" {
  if (c.testPolicy?.suite) return c.testPolicy.suite;
  return c.testEnvironment &&
    testCapabilities(c.testEnvironment, c.testPolicy).suite === "supported" &&
    authoredChecksUnavailable(c)
    ? "required"
    : "advisory";
}
