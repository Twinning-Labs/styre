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

const JIRA_ENV = {
  JIRA_BASE_URL: "https://x.atlassian.net",
  JIRA_EMAIL: "a@b.com",
  JIRA_API_TOKEN: "tok",
} as const;

/** Run `fn` with the Jira env vars set, then put each one back exactly as it was. */
function withJiraEnv(fn: () => void): void {
  const prev = Object.fromEntries(Object.keys(JIRA_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, JIRA_ENV);
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('withJiraEnv leaves previously unset Jira env vars unset, not the string "undefined"', () => {
  const saved = Object.fromEntries(Object.keys(JIRA_ENV).map((k) => [k, process.env[k]]));
  for (const k of Object.keys(JIRA_ENV)) Reflect.deleteProperty(process.env, k);
  try {
    withJiraEnv(() => {});
    for (const k of Object.keys(JIRA_ENV)) expect(k in process.env).toBe(false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
});

test("makeProjectorPorts selects the jira adapter when configured", () => {
  withJiraEnv(() => {
    const ports = makeProjectorPorts(
      { issueTracker: "jira", forge: "github" },
      { checksSystem: "none", targetRepo: "/tmp/x" },
      // Isolate the forge (real githubForge needs an actual git checkout + GITHUB_TOKEN; irrelevant
      // to what this test proves — jira issueTracker selection).
      { forge: { github: () => fakeForge() } },
    );
    expect(typeof ports.issueTracker.fetchTicket).toBe("function");
  });
});
