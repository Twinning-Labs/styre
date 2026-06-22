import { expect, test } from "bun:test";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { selectForge } from "../../src/integrations/forge.ts";

test("selectForge returns the configured adapter", () => {
  const fake = fakeForge();
  expect(selectForge({ forge: "github" }, { github: () => fake })).toBe(fake);
});

test("selectForge throws on an unregistered adapter", () => {
  expect(() => selectForge({ forge: "gitlab" }, { github: () => fakeForge() })).toThrow();
});

test("fakeForge records calls and returns refs", async () => {
  const fake = fakeForge();
  await fake.push({ branch: "feat/x", sha: "abc" });
  const pr = await fake.ensurePr({ branch: "feat/x", base: "main", title: "t", body: "b" });
  const c = await fake.addPrComment(pr.ref, "hi", "k1");
  expect(fake.calls.map((x) => x.method)).toEqual(["push", "ensurePr", "addPrComment"]);
  expect(pr.ref).toContain("fake-pr");
  expect(c).not.toBeNull();
});
