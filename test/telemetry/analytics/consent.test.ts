import { afterEach, expect, test } from "bun:test";
import { telemetryEnabled } from "../../../src/telemetry/analytics/consent.ts";

const ENV_KEYS = ["DO_NOT_TRACK", "STYRE_TELEMETRY"] as const;
afterEach(() => {
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
});

test("enabled by default when config.telemetry is true and no env set", () => {
  expect(telemetryEnabled({ telemetry: true })).toBe(true);
});

test("config.telemetry=false disables", () => {
  expect(telemetryEnabled({ telemetry: false })).toBe(false);
});

test("DO_NOT_TRACK=1 disables; DO_NOT_TRACK=0 does not", () => {
  process.env.DO_NOT_TRACK = "1";
  expect(telemetryEnabled({ telemetry: true })).toBe(false);
  process.env.DO_NOT_TRACK = "0";
  expect(telemetryEnabled({ telemetry: true })).toBe(true);
});

test("STYRE_TELEMETRY=0 disables", () => {
  process.env.STYRE_TELEMETRY = "0";
  expect(telemetryEnabled({ telemetry: true })).toBe(false);
});

test('STYRE_TELEMETRY="false" disables', () => {
  process.env.STYRE_TELEMETRY = "false";
  expect(telemetryEnabled({ telemetry: true })).toBe(false);
});

test('DO_NOT_TRACK="" is NOT opt-out (stays enabled)', () => {
  process.env.DO_NOT_TRACK = "";
  expect(telemetryEnabled({ telemetry: true })).toBe(true);
});

test('DO_NOT_TRACK="false" is NOT opt-out (stays enabled)', () => {
  process.env.DO_NOT_TRACK = "false";
  expect(telemetryEnabled({ telemetry: true })).toBe(true);
});
