import { expect, test } from "bun:test";
import { runNotifyTest } from "../../src/cli/notify.ts";
import { RuntimeConfigSchema } from "../../src/config/runtime-config.ts";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";

test("runNotifyTest sends one test message via the notifier and returns its ref", async () => {
  const notifier = fakeNotifier();
  const rc = RuntimeConfigSchema.parse({
    notifier: "slack",
    notify: "escalations",
    slack: { channel: "#x" },
  });
  const ref = await runNotifyTest(rc, { notifier });
  expect(notifier.calls.length).toBe(1);
  expect(notifier.calls[0]?.event).toContain("test");
  expect(ref).toContain("fake-ts");
});

test("runNotifyTest fails loud when notifier is not configured", async () => {
  const rc = RuntimeConfigSchema.parse({}); // notifier: "none"
  await expect(runNotifyTest(rc, {})).rejects.toThrow();
});
