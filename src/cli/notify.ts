import { defineCommand } from "citty";
import { discoverRuntimeConfig, slugForCwd } from "../config/discover.ts";
import type { RuntimeConfig } from "../config/runtime-config.ts";
import { slackNotifier } from "../integrations/adapters/slack.ts";
import {
  type NotifierPort,
  assertSlackConfigured,
  selectNotifier,
} from "../integrations/notifier.ts";
import { configError, usageError } from "./errors.ts";
import { guard } from "./output.ts";

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
  if (!notifier) {
    throw configError({
      file: "config.json",
      field: "notifier",
      detail: 'notifier is "none" — nothing to test.',
      recovery: 'Set notifier: "slack" in config.json and re-run.',
    });
  }
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
    slug: {
      type: "string",
      description: "Project slug for per-project config (default: derived from the cwd repo)",
    },
  },
  run: (ctx) => guard("notify", () => notifyImpl({ args: ctx.args as unknown as NotifyArgs })),
});

export interface NotifyArgs {
  test?: boolean;
  config?: string;
  slug?: string;
}

export async function notifyImpl({ args }: { args: NotifyArgs }): Promise<void> {
  if (!args.test) {
    throw usageError("notify requires --test", "Run: styre notify --test");
  }
  // Resolve config the same way `styre run` does, so per-project (per-slug) Slack config is
  // picked up — otherwise `notify --test` could verify a different channel than a real run uses.
  const slug = args.slug && args.slug.length > 0 ? args.slug : (slugForCwd() ?? undefined);
  const rc = discoverRuntimeConfig({ explicitPath: args.config, slug });
  const ref = await runNotifyTest(rc, {});
  process.stderr.write(
    `notifier: ${rc.notifier} → ${rc.slack?.channel}\n✓ sent test message (ts ${ref})\n`,
  );
}
