import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  loadOrCreateState,
  markNoticeShown,
} from "../../../src/telemetry/analytics/id.ts";

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "styre-id-"));
});
afterEach(() => {
  if (prev === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prev;
});

test("first call creates a UUID and persists it; second call reuses it", () => {
  const a = loadOrCreateState();
  expect(a.distinctId).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.noticeShown).toBe(false);
  const b = loadOrCreateState();
  expect(b.distinctId).toBe(a.distinctId);
});

test("markNoticeShown persists the flag", () => {
  const s = loadOrCreateState();
  markNoticeShown(s);
  const file = join(process.env.XDG_STATE_HOME as string, "styre", "telemetry.json");
  expect(JSON.parse(readFileSync(file, "utf8")).noticeShown).toBe(true);
  expect(loadOrCreateState().noticeShown).toBe(true);
});
