import { afterEach, expect, test } from "bun:test";
import { credNote } from "../../src/cli/setup.ts";

const KEYS = ["LINEAR_API_KEY", "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "GITHUB_TOKEN"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const clear = () => {
  for (const k of KEYS) delete process.env[k];
};

test("no JIRA vars: reports missing LINEAR_API_KEY", () => {
  clear();
  const note = credNote({ checksSystem: "none" } as never);
  expect(note).toContain("LINEAR_API_KEY");
});

test("any JIRA var present: reports the missing JIRA trio, not LINEAR", () => {
  clear();
  process.env.JIRA_BASE_URL = "https://x.atlassian.net";
  const note = credNote({ checksSystem: "none" } as never);
  expect(note).toContain("JIRA_EMAIL");
  expect(note).toContain("JIRA_API_TOKEN");
  expect(note).not.toContain("LINEAR_API_KEY");
});

test("full JIRA trio present: no ticket-cred note", () => {
  clear();
  process.env.JIRA_BASE_URL = "https://x.atlassian.net";
  process.env.JIRA_EMAIL = "a@b.com";
  process.env.JIRA_API_TOKEN = "tok";
  expect(credNote({ checksSystem: "none" } as never)).toBeNull();
});
