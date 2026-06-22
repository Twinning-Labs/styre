import { expect, test } from "bun:test";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { selectIssueTracker } from "../../src/integrations/issue-tracker.ts";

test("selectIssueTracker returns the configured adapter", () => {
  const fake = fakeIssueTracker();
  const port = selectIssueTracker({ issueTracker: "linear" }, { linear: () => fake });
  expect(port).toBe(fake);
});

test("selectIssueTracker throws on an unregistered adapter", () => {
  expect(() =>
    selectIssueTracker({ issueTracker: "jira" }, { linear: () => fakeIssueTracker() }),
  ).toThrow();
});

test("fakeIssueTracker records calls", async () => {
  const fake = fakeIssueTracker();
  await fake.setState("ENG-1", "in_progress");
  await fake.setLabels("ENG-1", { add: ["stage:implement"], remove: ["stage:design"] });
  const id = await fake.addComment("ENG-1", "hi", "k1");
  expect(fake.calls.map((c) => c.method)).toEqual(["setState", "setLabels", "addComment"]);
  expect(id).not.toBeUndefined();
});
