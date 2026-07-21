import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runImpl } from "../../src/cli/run.ts";
import type { AnalyticsClient } from "../../src/telemetry/analytics/client.ts";

interface Captured {
  event: string;
  properties: Record<string, unknown>;
}
function fakeClient(): { client: AnalyticsClient; events: Captured[] } {
  const events: Captured[] = [];
  return {
    events,
    client: {
      capture: (_distinctId, event, properties) => events.push({ event, properties }),
      shutdown: async () => {},
    },
  };
}

/** Write a raw JSON object to a temp file and return its path. */
function tmpJson(prefix: string, obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, `${prefix}.json`);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

/** A minimal, valid profile (empty components → assertResolved passes). */
function validProfilePath(): string {
  return tmpJson("styre-prof-", {
    slug: "eng354",
    targetRepo: "/tmp/eng354-repo",
    defaultBranch: "main",
    checksSystem: "none",
  });
}

// Isolate telemetry state to a temp dir, and neutralize env opt-outs so the fallback path emits.
let prevXdg: string | undefined;
let prevDnt: string | undefined;
let prevStyre: string | undefined;
beforeEach(() => {
  prevXdg = process.env.XDG_STATE_HOME;
  prevDnt = process.env.DO_NOT_TRACK;
  prevStyre = process.env.STYRE_TELEMETRY;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "styre-clierr-state-"));
  Reflect.deleteProperty(process.env, "DO_NOT_TRACK");
  Reflect.deleteProperty(process.env, "STYRE_TELEMETRY");
});
afterEach(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) {
      Reflect.deleteProperty(process.env, k);
    } else {
      process.env[k] = v;
    }
  };
  restore("XDG_STATE_HOME", prevXdg);
  restore("DO_NOT_TRACK", prevDnt);
  restore("STYRE_TELEMETRY", prevStyre);
});

test("early config error (bad adapter) emits cli_error with exit_code 78 / error_kind config", async () => {
  const profile = validProfilePath();
  const config = tmpJson("styre-cfg-", { issueTracker: "liner" }); // unknown adapter → ConfigError (78)
  const { client, events } = fakeClient();

  await expect(
    runImpl({ args: { profile, config, ticket: "ENG-1" } }, { analyticsClient: client }),
  ).rejects.toThrow();

  const cliErr = events.find((e) => e.event === "cli_error");
  expect(cliErr).toBeDefined();
  expect(cliErr?.properties.exit_code).toBe(78);
  expect(cliErr?.properties.error_kind).toBe("config");
});

test("earliest error (malformed --profile, before config) still emits cli_error via fallback", async () => {
  const badProfile = tmpJson("styre-prof-", { commands: {} }); // legacy shape → throws in parseProfile
  const { client, events } = fakeClient();

  await expect(
    runImpl({ args: { profile: badProfile, ticket: "ENG-1" } }, { analyticsClient: client }),
  ).rejects.toThrow();

  expect(events.some((e) => e.event === "cli_error")).toBe(true);
});

test("telemetry off in config → later error emits NO cli_error (opt-out preserved)", async () => {
  const profile = validProfilePath();
  const config = tmpJson("styre-cfg-", { telemetry: false }); // valid, telemetry disabled
  const { client, events } = fakeClient();

  // No ticket, no resume → usageError thrown AFTER analytics is built (as NOOP).
  await expect(
    runImpl({ args: { profile, config } }, { analyticsClient: client }),
  ).rejects.toThrow();

  expect(events.some((e) => e.event === "cli_error")).toBe(false);
});

test("fallback honors DO_NOT_TRACK — early error emits no cli_error even with a client available", async () => {
  // Early-throw path builds the fallback createAnalytics({ telemetry: true }); DO_NOT_TRACK must
  // still veto it. The guarantee lives in consent.ts; asserted here end-to-end through runImpl.
  // Positive control: the sibling "earliest error … via fallback" test (no DO_NOT_TRACK) DOES capture.
  process.env.DO_NOT_TRACK = "1";
  const badProfile = tmpJson("styre-prof-", { commands: {} }); // throws before config → fallback path
  const { client, events } = fakeClient();

  await expect(
    runImpl({ args: { profile: badProfile, ticket: "ENG-1" } }, { analyticsClient: client }),
  ).rejects.toThrow();

  expect(events.some((e) => e.event === "cli_error")).toBe(false);
});
