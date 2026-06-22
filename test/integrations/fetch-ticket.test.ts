import { expect, test } from "bun:test";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";

test("fakeIssueTracker.fetchTicket returns the canned ticket and records the call", async () => {
  const it = fakeIssueTracker({
    ticket: {
      ident: "ENG-1",
      title: "T",
      description: "B",
      typeLabel: "Bug",
      linearIssueUuid: "u",
      url: "http://x",
    },
  });
  const got = await it.fetchTicket("ENG-1");
  expect(got.ident).toBe("ENG-1");
  expect(got.typeLabel).toBe("Bug");
  expect(it.calls.some((c) => c.method === "fetchTicket" && c.args[0] === "ENG-1")).toBe(true);
});
