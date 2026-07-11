import { defineCommand } from "citty";
import { discoverRuntimeConfig } from "../config/discover.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { slackNotifier } from "../integrations/adapters/slack.ts";
import {
  type NotifierPort,
  assertSlackConfigured,
  selectNotifier,
} from "../integrations/notifier.ts";

/** Testable core: send one test notification. Throws (fail-loud) if the notifier is misconfigured. */
export async function runNotifyTest(
  rc: RuntimeConfig,
  deps: { notifier?: NotifierPort },
): Promise<string> {
  // Only validate + construct the real notifier when one isn't injected. `assertSlackConfigured`
  // reads the env token, so it must NOT run when a test supplies a fake notifier.
  let notifier = deps.notifier;
  if (!notifier) {
    assertSlackConfigured(rc); // fail-loud on the real path (missing token/channel)
    notifier = selectNotifier(
      { notifier: rc.notifier },
      {
        slack: () =>
          slackNotifier({
            token: process.env.SLACK_BOT_TOKEN ?? "",
            channel: rc.slack?.channel ?? "",
          }),
      },
    );
  }
  if (!notifier) throw new Error('notify --test: no notifier configured (set notifier: "slack")');
  const { ref } = await notifier.notify({
    ticketIdent: "styre",
    event: "notifier test — hello from Styre",
    severity: "info",
  });
  return ref;
}

export const notifyCommand = defineCommand({
  meta: { name: "notify", description: "Notifier utilities" },
  args: {
    test: { type: "boolean", description: "Send one test message to the configured channel" },
    config: { type: "string", description: "Explicit config.json path" },
  },
  async run({ args }) {
    if (!args.test) {
      process.stderr.write("usage: styre notify --test\n");
      process.exitCode = 2;
      return;
    }
    const rc = discoverRuntimeConfig({ explicitPath: args.config });
    const ref = await runNotifyTest(rc, {});
    process.stderr.write(
      `notifier: ${rc.notifier} → ${rc.slack?.channel}\n✓ sent test message (ts ${ref})\n`,
    );
  },
});
