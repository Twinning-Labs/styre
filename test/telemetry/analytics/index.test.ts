import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AnalyticsClient } from "../../../src/telemetry/analytics/client.ts";
import { createAnalytics } from "../../../src/telemetry/analytics/index.ts";
import { ALLOWED_KEYS } from "../../../src/telemetry/analytics/properties.ts";

interface Captured {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
}
function fakeClient(): { client: AnalyticsClient; events: Captured[] } {
  const events: Captured[] = [];
  return {
    events,
    client: {
      capture: (distinctId, event, properties) => events.push({ distinctId, event, properties }),
      shutdown: async () => {},
    },
  };
}

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "styre-an-"));
});
afterEach(() => {
  if (prev === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prev;
});

test("disabled config → no-op: no capture, no client needed", async () => {
  const { client, events } = fakeClient();
  const a = createAnalytics({ telemetry: false }, { client });
  a.runStarted({ projectId: "p", resumed: false, tracker: "linear", forge: "github" });
  await a.shutdown();
  expect(events.length).toBe(0);
});

test("enabled → events carry super-props + a distinct_id, all keys allow-listed", async () => {
  const { client, events } = fakeClient();
  const a = createAnalytics({ telemetry: true }, { client });
  a.runStarted({ projectId: "p", resumed: false, tracker: "linear", forge: "github" });
  await a.shutdown();
  expect(events.length).toBe(1);
  const e = events[0];
  expect(e.event).toBe("run_started");
  expect(e.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  expect(e.properties.styre_version).toBeDefined();
  expect(e.properties.project_id).toBe("p");
  for (const k of Object.keys(e.properties)) expect(ALLOWED_KEYS.has(k)).toBe(true);
});

test("setup failure (unwritable state dir) → NOOP, never throws", async () => {
  // Point XDG_STATE_HOME at a path nested under an existing FILE so mkdirSync(recursive)
  // throws ENOTDIR when id.ts tries to persist state. createAnalytics must swallow it.
  const f = join(mkdtempSync(join(tmpdir(), "styre-an-")), "afile");
  writeFileSync(f, "not a dir");
  process.env.XDG_STATE_HOME = join(f, "x");

  const { client, events } = fakeClient();
  let a: ReturnType<typeof createAnalytics> | undefined;
  expect(() => {
    a = createAnalytics({ telemetry: true }, { client });
  }).not.toThrow();
  if (!a) throw new Error("createAnalytics did not return");
  // Methods are no-ops that do not throw; shutdown resolves.
  expect(() => {
    a?.runStarted({ projectId: "p", resumed: false, tracker: "linear", forge: "github" });
    a?.setupCompleted({
      projectId: "p",
      checksSystem: "make",
      componentCount: 1,
      componentKinds: ["backend"],
      stackBucket: "node",
      topologyType: "monolith",
    });
    a?.cliError({ command: "run", exitCode: 1, errorClass: "Error" });
  }).not.toThrow();
  await a.shutdown();
  expect(events.length).toBe(0);
});
