import type { NotificationMessage, NotifierPort } from "../notifier.ts";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const EMOJI: Record<NotificationMessage["severity"], string> = {
  high: "🔴",
  success: "🟢",
  info: "▸",
};

/** Slack adapter: posts one message per notification via chat.postMessage. Token + channel are
 *  passed in (token originates from SLACK_BOT_TOKEN in env, resolved in makeProjectorPorts).
 *  `fetch` is injectable for tests. v1 renders mrkdwn text; Block Kit is a later enrichment. */
export function slackNotifier(opts: { token: string; channel: string; fetch?: FetchLike }): NotifierPort {
  const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
  return {
    async notify(msg) {
      const text = `${EMOJI[msg.severity]} *${msg.ticketIdent}* ${msg.event}${
        msg.reason ? `: ${msg.reason}` : ""
      }`;
      const res = await doFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ channel: opts.channel, text }),
      });
      const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
      if (!data.ok) {
        throw new Error(`slack chat.postMessage failed: ${data.error ?? "unknown error"}`);
      }
      return { ref: data.ts ?? "" };
    },
  };
}
