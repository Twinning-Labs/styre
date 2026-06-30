import { expect, test } from "bun:test";
import { parseProfile } from "../../src/dispatch/profile.ts";

const base = {
  schemaVersion: 3,
  slug: "demo",
  targetRepo: "/repo",
  components: [],
  runtimeContext: {},
};

test("analyticsId is optional and preserved when present", () => {
  expect(parseProfile(base).analyticsId).toBeUndefined();
  const withId = parseProfile({ ...base, analyticsId: "abc-123" });
  expect(withId.analyticsId).toBe("abc-123");
});
