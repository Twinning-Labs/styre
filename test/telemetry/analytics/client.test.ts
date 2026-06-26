import { expect, test } from "bun:test";
import { createPosthogClient } from "../../../src/telemetry/analytics/client.ts";

test("client constructs; capture never throws; shutdown resolves within the bound", async () => {
  const client = createPosthogClient();
  expect(() => client.capture("anon-1", "test_event", { ok: true })).not.toThrow();
  const start = Date.now();
  await client.shutdown();
  expect(Date.now() - start).toBeLessThan(3000);
});
