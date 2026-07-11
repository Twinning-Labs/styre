/** Vendor-neutral notifier port (zero lock-in). The core builds a neutral NotificationMessage;
 *  Slack/Discord/etc. are config-selected adapters behind this interface. Mirrors selectIssueTracker
 *  (src/integrations/issue-tracker.ts). Outbound-only: a notification is a one-way projection and
 *  must never be read for control flow. */

export type NotifySeverity = "high" | "success" | "info";

export interface NotificationMessage {
  ticketIdent: string; // "ENG-1"
  event: string; // "escalated" | "implement→verify" | "PR ready to merge" | ...
  severity: NotifySeverity;
  reason?: string;
}

export interface NotifierPort {
  /** Deliver one rendered notification. Returns a provider ref (e.g. Slack ts). Throws on
   *  transport failure — the projector's drain decides retry (and never escalates a notify row). */
  notify(msg: NotificationMessage): Promise<{ ref: string }>;
}

export type NotifierFactory = () => NotifierPort;

export function selectNotifier(
  config: { notifier: string },
  adapters: Record<string, NotifierFactory>,
): NotifierPort | undefined {
  if (config.notifier === "none") return undefined;
  const factory = adapters[config.notifier];
  if (!factory) {
    throw new Error(`selectNotifier: no adapter registered for '${config.notifier}'`);
  }
  return factory();
}

/** Fail-loud config validation (design §4). MUST run eagerly at startup, not lazily inside the
 *  adapter — a lazy read would surface as a swallowed transport error (no escalate) = silent drop. */
export function assertSlackConfigured(
  config: { notifier: string; slack?: { channel: string } },
  env: { SLACK_BOT_TOKEN?: string } = process.env as { SLACK_BOT_TOKEN?: string },
): void {
  if (config.notifier !== "slack") return;
  if (!env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN.length === 0) {
    throw new Error(
      "notifier 'slack' is set but SLACK_BOT_TOKEN is missing from the environment",
    );
  }
  if (!config.slack || config.slack.channel.length === 0) {
    throw new Error("notifier 'slack' is set but slack.channel is missing from config.json");
  }
}
