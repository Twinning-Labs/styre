import { describe, expect, test } from "bun:test";
import setupEnrichTemplate from "../../prompts/setup-enrich.md" with { type: "text" };
import { ReleaseMechanismEnum, TopologyTypeEnum } from "../../src/dispatch/profile.ts";

describe("setup-enrich prompt lists the full enum vocabulary (drift guard)", () => {
  // Match the DELIMITED backtick-wrapped form `value`, not a bare substring — otherwise
  // "none"/"unknown" match the surrounding prose and the guard is vacuous.
  test("every TopologyTypeEnum value is listed (backtick-delimited) in the prompt", () => {
    for (const t of TopologyTypeEnum.options) {
      expect(setupEnrichTemplate).toContain(`\`${t}\``);
    }
  });
  test("every ReleaseMechanismEnum value is listed (backtick-delimited) in the prompt", () => {
    for (const m of ReleaseMechanismEnum.options) {
      expect(setupEnrichTemplate).toContain(`\`${m}\``);
    }
  });
  test("the prompt instructs never-invent + fail-soft to unknown, and a disambiguation rule", () => {
    expect(/never invent|must be exactly one of/i.test(setupEnrichTemplate)).toBe(true);
    expect(setupEnrichTemplate).toContain("`unknown`");
    expect(/prefer|precedence|if .*configured/i.test(setupEnrichTemplate)).toBe(true);
  });
});
