import { expect, test } from "bun:test";
import {
  deriveSetupInput,
  ensureAnalyticsId,
} from "../../src/cli/setup.ts";
import type { Profile } from "../../src/dispatch/profile.ts";

const profile: Profile = {
  schemaVersion: 2 as const,
  slug: "demo",
  targetRepo: "/repo",
  defaultBranch: "main",
  checksSystem: "github" as const,
  components: [
    { name: "api", kind: "backend", paths: ["api/"], commands: {} },
    { name: "web", kind: "frontend", paths: ["web/"], commands: {} },
  ],
  repoCommands: {},
  promptVars: { TECHNOLOGY_STACK: "Node.js + Express" },
  runtimeContext: {
    topology: { type: "web-n-tier", detail: "" },
    data: { presence: "present", detail: "" },
    caching: { presence: "unknown", detail: "" },
    observability: { presence: "unknown", detail: "" },
    configSecrets: { presence: "unknown", detail: "" },
    documentation: { presence: "unknown", detail: "" },
    releasePackaging: { mechanism: "none", detail: "" },
  },
};

test("ensureAnalyticsId generates when absent, preserves when present", () => {
  const a = ensureAnalyticsId(profile);
  expect(a.analyticsId).toMatch(/^[0-9a-f-]{36}$/);
  const b = ensureAnalyticsId({ ...profile, analyticsId: "keep-me" });
  expect(b.analyticsId).toBe("keep-me");
});

test("deriveSetupInput maps to coarse, allow-listed inputs", () => {
  const input = deriveSetupInput({ ...profile, analyticsId: "pid" });
  expect(input.projectId).toBe("pid");
  expect(input.checksSystem).toBe("github");
  expect(input.componentCount).toBe(2);
  expect(input.componentKinds.sort()).toEqual(["backend", "frontend"]);
  expect(input.stackBucket).toBe("node");
  expect(input.topologyType).toBe("web-n-tier");
});
