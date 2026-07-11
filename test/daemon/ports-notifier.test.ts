import { expect, test } from "bun:test";
import { makeProjectorPorts } from "../../src/daemon/ports.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";

const profile = { checksSystem: "none", targetRepo: "/tmp/repo" };

// issueTracker/forge use fakes here (mirrors ports.test.ts) — the real adapters would try to hit
// LINEAR_API_KEY / read /tmp/repo's git remote, which is irrelevant to what this test verifies:
// notifier selection.
const baseDeps = {
  issueTracker: { linear: () => fakeIssueTracker() },
  forge: { github: () => fakeForge() },
};

test("makeProjectorPorts attaches the selected notifier; 'none' → undefined", () => {
  const fake = fakeNotifier();
  const withSlack = makeProjectorPorts(
    { issueTracker: "linear", forge: "github", notifier: "slack", slack: { channel: "#x" } },
    profile,
    { ...baseDeps, notifier: { slack: () => fake } },
  );
  expect(withSlack.notifier).toBe(fake);

  const off = makeProjectorPorts(
    { issueTracker: "linear", forge: "github", notifier: "none" },
    profile,
    baseDeps,
  );
  expect(off.notifier).toBeUndefined();
});
