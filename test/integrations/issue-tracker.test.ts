import { expect, test } from "bun:test";
import { makeProjectorPorts } from "../../src/daemon/ports.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
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

test("makeProjectorPorts selects the jira adapter when configured", () => {
  const prev = {
    u: process.env.JIRA_BASE_URL,
    e: process.env.JIRA_EMAIL,
    t: process.env.JIRA_API_TOKEN,
  };
  process.env.JIRA_BASE_URL = "https://x.atlassian.net";
  process.env.JIRA_EMAIL = "a@b.com";
  process.env.JIRA_API_TOKEN = "tok";
  try {
    const ports = makeProjectorPorts(
      { issueTracker: "jira", forge: "github" },
      { checksSystem: "none", targetRepo: "/tmp/x" },
      // Isolate the forge (real githubForge needs an actual git checkout + GITHUB_TOKEN; irrelevant
      // to what this test proves — jira issueTracker selection).
      { forge: { github: () => fakeForge() } },
    );
    expect(typeof ports.issueTracker.fetchTicket).toBe("function");
  } finally {
    process.env.JIRA_BASE_URL = prev.u;
    process.env.JIRA_EMAIL = prev.e;
    process.env.JIRA_API_TOKEN = prev.t;
  }
});
