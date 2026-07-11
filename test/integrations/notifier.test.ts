import { expect, test } from "bun:test";
import { fakeNotifier } from "../../src/integrations/adapters/fake-notifier.ts";
import {
  NotificationMessageSchema,
  assertSlackConfigured,
  selectNotifier,
} from "../../src/integrations/notifier.ts";

test("selectNotifier: 'none' → undefined, 'slack' → adapter, unknown → throw", () => {
  expect(selectNotifier({ notifier: "none" }, {})).toBeUndefined();
  const fake = fakeNotifier();
  expect(selectNotifier({ notifier: "slack" }, { slack: () => fake })).toBe(fake);
  expect(() => selectNotifier({ notifier: "discord" }, { slack: () => fake })).toThrow();
});

test("assertSlackConfigured: passes when off; throws on missing token or channel", () => {
  expect(() => assertSlackConfigured({ notifier: "none" }, {})).not.toThrow();
  expect(() => assertSlackConfigured({ notifier: "slack", slack: { channel: "#x" } }, {})).toThrow(
    /SLACK_BOT_TOKEN/,
  );
  expect(() => assertSlackConfigured({ notifier: "slack" }, { SLACK_BOT_TOKEN: "xoxb-1" })).toThrow(
    /slack.channel/,
  );
  expect(() =>
    assertSlackConfigured(
      { notifier: "slack", slack: { channel: "#x" } },
      { SLACK_BOT_TOKEN: "xoxb-1" },
    ),
  ).not.toThrow();
});

test("fakeNotifier records calls and can force failure", async () => {
  const ok = fakeNotifier();
  const r = await ok.notify({ ticketIdent: "ENG-1", event: "escalated", severity: "high" });
  expect(r.ref).toContain("fake-ts");
  expect(ok.calls[0]?.ticketIdent).toBe("ENG-1");
  const bad = fakeNotifier({ fail: true });
  await expect(
    bad.notify({ ticketIdent: "ENG-2", event: "x", severity: "info" }),
  ).rejects.toThrow();
});

test("NotificationMessageSchema accepts optional title/prUrl and rejects a bad severity", () => {
  const ok = NotificationMessageSchema.parse({
    ticketIdent: "ENG-1",
    event: "escalated",
    severity: "high",
    reason: "boom",
    ticketTitle: "Fix widget",
    prUrl: "https://gh/pr/1",
  });
  expect(ok.ticketTitle).toBe("Fix widget");
  expect(ok.prUrl).toBe("https://gh/pr/1");
  // minimal message still valid (fields optional)
  expect(
    NotificationMessageSchema.parse({ ticketIdent: "ENG-2", event: "x", severity: "info" })
      .ticketTitle,
  ).toBeUndefined();
  // invalid severity rejected
  expect(() =>
    NotificationMessageSchema.parse({ ticketIdent: "ENG-3", event: "x", severity: "loud" }),
  ).toThrow();
});
