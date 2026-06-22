import { expect, test } from "bun:test";
import { makeProjectorPorts } from "../../src/daemon/ports.ts";
import { fakeChecks } from "../../src/integrations/adapters/fake-checks.ts";
import { fakeForge } from "../../src/integrations/adapters/fake-forge.ts";
import { fakeIssueTracker } from "../../src/integrations/adapters/fake-issue-tracker.ts";

const deps = {
  issueTracker: { linear: () => fakeIssueTracker() },
  forge: { github: () => fakeForge() },
  checks: { github: () => fakeChecks() },
};

test("wires issueTracker + forge from runtime config", () => {
  const ports = makeProjectorPorts(
    { issueTracker: "linear", forge: "github" },
    { checksSystem: "github", targetRepo: "/tmp/x" },
    deps,
  );
  expect(ports.issueTracker).toBeDefined();
  expect(ports.forge).toBeDefined();
  expect(ports.checks).toBeDefined();
});

test("checksSystem 'none' yields no checks port", () => {
  const ports = makeProjectorPorts(
    { issueTracker: "linear", forge: "github" },
    { checksSystem: "none", targetRepo: "/tmp/x" },
    deps,
  );
  expect(ports.checks).toBeUndefined();
});
