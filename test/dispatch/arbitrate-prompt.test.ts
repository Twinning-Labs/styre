import { expect, test } from "bun:test";
import { resolveTier } from "../../src/agent/tiers.ts";
import { parseProfile } from "../../src/dispatch/profile.ts";
import { CHECKS_ARBITRATE_TEMPLATE, arbitrateVars } from "../../src/dispatch/prompt-vars.ts";
import { allowlistFor } from "../../src/dispatch/tool-allowlists.ts";

test("checks:arbitrate is deep + read-only (no Bash/Write/Edit)", () => {
  expect(resolveTier("checks:arbitrate")).toBe("deep");
  const tools = allowlistFor("checks:arbitrate");
  expect(tools).toEqual(["Read", "Grep", "Glob"]);
  expect(tools).not.toContain("Bash");
});

test("the arbiter prompt demands a POSITIVE AC-contradiction for check-wrong and forbids code-as-oracle", () => {
  const t = CHECKS_ARBITRATE_TEMPLATE.toLowerCase();
  expect(t).toContain("check-wrong");
  expect(t).toContain("code-wrong");
  expect(t).toMatch(/positive|explicitly rules out|contradict/); // positive AC-contradiction
  expect(t).toMatch(/silent/); // AC-silent → default code-wrong
  expect(t).toMatch(/never re-?run|do not re-?run/); // judges from the trace, never re-runs
});

test("arbitrateVars renders one block per check with AC text + recorded trace + source", () => {
  const profile = parseProfile({ slug: "demo", targetRepo: "/x", components: [] });
  const vars = arbitrateVars({ ident: "ENG-1", title: "t" }, profile, [
    {
      acCheckId: 9,
      acText: "returns 201",
      testPath: "checks/a_test.py",
      testName: "test_ac",
      coarse: "red",
      trace: "assert 200 == 201",
      source: "def test_ac(): ...",
    },
  ]);
  expect(vars.checks_to_arbitrate).toContain("ac_check_id=9");
  expect(vars.checks_to_arbitrate).toContain("returns 201");
  expect(vars.checks_to_arbitrate).toContain("assert 200 == 201");
});
