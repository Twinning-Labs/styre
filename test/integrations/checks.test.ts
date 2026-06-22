import { expect, test } from "bun:test";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { selectChecks } from "../../src/integrations/checks.ts";

test("selectChecks returns the registered adapter", () => {
  const port = selectChecks("github", { github: () => fakeChecks("passing") });
  expect(port).not.toBeNull();
});

test("selectChecks returns null for an unregistered key (none/external/unknown)", () => {
  const adapters = { github: () => fakeChecks() };
  expect(selectChecks("none", adapters)).toBeNull();
  expect(selectChecks("external", adapters)).toBeNull();
  expect(selectChecks("gitlab", adapters)).toBeNull();
});

test("fakeChecks records calls and returns the configured verdict", async () => {
  const c = fakeChecks("failing");
  const v = await c.status({ ref: "abc123" });
  expect(v).toBe("failing");
  expect(c.calls).toEqual([{ method: "status", args: [{ ref: "abc123" }] }]);
});

test("fakeChecks defaults to passing", async () => {
  expect(await fakeChecks().status({ ref: "x" })).toBe("passing");
});
