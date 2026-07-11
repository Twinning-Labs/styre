import { expect, test } from "bun:test";
import { RuntimeConfigSchema } from "../../src/config/runtime-config.ts";

test("notify fields default to off/escalations and parse a slack block", () => {
  const def = RuntimeConfigSchema.parse({});
  expect(def.notifier).toBe("none");
  expect(def.notify).toBe("escalations");
  expect(def.slack).toBeUndefined();

  const cfg = RuntimeConfigSchema.parse({
    notifier: "slack",
    notify: "transitions",
    slack: { channel: "#styre" },
  });
  expect(cfg.notifier).toBe("slack");
  expect(cfg.notify).toBe("transitions");
  expect(cfg.slack?.channel).toBe("#styre");
});
